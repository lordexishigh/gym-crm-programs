import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { dispatchDueTasks } from "@/lib/task-handlers";
import { captureException } from "@/lib/observability/monitoring";

/**
 * The queue's trigger: sweep for due work, then drain it.
 *
 * This replaces `.github/workflows/membership-expiry.yml` as the scheduler for
 * everything periodic. Two reasons, one general and one specific to this repo:
 *
 *   - General: a scheduled HTTP endpoint on the platform that already runs the
 *     app needs no checkout, no `npm ci`, no second copy of the email templates
 *     (the workflow's script carried a hand-duplicated copy of
 *     `sendMembershipExpiryEmail` because a .mjs script cannot import our
 *     TypeScript), and no separate set of secrets to keep in sync.
 *   - Specific: GitHub Actions on this repository has been failing on a spending
 *     limit since 2026-07-30 — every workflow dies in about four seconds. So the
 *     renewal reminder has, in practice, never run. Moving the trigger onto
 *     Vercel Cron (see `crons` in vercel.json) puts scheduled work on the same
 *     platform as the app it serves, which is the only one currently able to run
 *     it.
 *
 * Auth: a bearer token compared against `CRON_SECRET`. Vercel Cron sends exactly
 * this header, so the same endpoint serves the scheduler and a manual run
 * (`curl -H "Authorization: Bearer $CRON_SECRET" .../api/tasks/dispatch`).
 * Without the secret set the route refuses every request rather than defaulting
 * to open — an unauthenticated endpoint that sends email to members is an abuse
 * primitive, and "the env var was missing" is not a reason to expose one.
 * `lib/capabilities.ts` reports that missing secret as a `degraded` gap, so a
 * deployment that cannot run its own scheduled work says so on the dashboard
 * instead of just going quiet.
 */
export const dynamic = "force-dynamic";

/**
 * A dispatch run must finish inside the platform's function budget. Draining
 * fewer tasks per run is harmless — the rest keep their `due_at` and the next
 * run takes them — whereas overrunning is not: the function is killed mid-task,
 * and only the lease (migration 0020) makes that recoverable rather than a lost
 * reminder. So the batch is small by default.
 */
const DEFAULT_LIMIT = 25;

/**
 * The lease must outlive the run that holds it, or a slow task's row becomes
 * claimable while it is still being processed — and the member gets two emails,
 * which is the bug this whole mechanism exists to prevent. Five minutes against
 * a batch of 25 short tasks is generous.
 */
const LEASE_SECONDS = 300;

/**
 * Constant-time comparison of the presented token against the configured one.
 *
 * `timingSafeEqual` throws on a length mismatch, and length is not a secret, so
 * that case is answered directly. The buffers are compared only when the lengths
 * already match.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorize(request: Request): { ok: true } | { ok: false; status: number; error: string } {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return {
      ok: false,
      // 503, not 401: the request may well have been correct. The DEPLOYMENT is
      // not configured to run scheduled work, and reporting that as an auth
      // failure would send an operator hunting for the wrong problem.
      status: 503,
      error:
        "Scheduled jobs are not configured on this deployment (CRON_SECRET is unset). Nothing was dispatched.",
    };
  }

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented || !tokenMatches(presented, secret)) {
    return { ok: false, status: 401, error: "Unauthorized." };
  }
  return { ok: true };
}

async function dispatch(request: Request): Promise<NextResponse> {
  const auth = authorize(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  const started = Date.now();
  try {
    const summary = await dispatchDueTasks({
      limit: DEFAULT_LIMIT,
      leaseSeconds: LEASE_SECONDS,
    });

    // One structured line per run, so "did the scheduler run, and did it do
    // anything?" is answerable from the platform log without a database.
    console.log(
      `[tasks] dispatch: enqueued=${summary.enqueued} claimed=${summary.claimed} ` +
        `succeeded=${summary.succeeded} failed=${summary.failed} in ${Date.now() - started}ms`,
    );

    return NextResponse.json(
      { ok: true, ...summary, duration_ms: Date.now() - started },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    // A throw here means the sweep or the claim failed — i.e. the database is
    // unreachable — not that a task failed (those are recorded per-task and
    // never propagate). 500 so the scheduler's own retry/alerting sees it.
    await captureException(err, {
      source: "task-dispatch-route",
      severity: "error",
    });
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - started,
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/** Vercel Cron issues a GET. */
export async function GET(request: Request) {
  return dispatch(request);
}

/** POST is accepted too, for a manual or external trigger. */
export async function POST(request: Request) {
  return dispatch(request);
}
