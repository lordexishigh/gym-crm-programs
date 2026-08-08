import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { authConfigured } from "@/lib/auth/supabase";
import { capabilityGaps, capabilitySummary } from "@/lib/capabilities";

// Always evaluated at request time so deploy smoke checks reflect live state.
export const dynamic = "force-dynamic";

/**
 * Liveness/readiness probe used by deploy pipelines and uptime monitors
 * (beta-hardening-001).
 *
 * Returns an aggregate `ok` plus a per-dependency breakdown:
 *   - `db`    a real `select 1` against Postgres (the critical dependency).
 *   - `email` whether transactional email is configured (informational — the
 *             app boots without it, so it does NOT fail the probe).
 *   - `auth`  whether sign-in is configured, i.e. whether anyone can get past
 *             /login and /portal/login at all (informational, for the same
 *             reason as `email`; see the field's comment in `GET` for why a
 *             deploy needs this reported rather than inferred).
 *
 * When the database is unreachable the route still responds (never throws) but
 * with HTTP 503 so an uptime monitor treats it as DOWN and alerts, while a
 * healthy check is 200. The DB ping is the only hard gate.
 *
 * A probe MUST answer faster than whatever is probing it is willing to wait,
 * otherwise a down dependency reads as a dead app: the monitor times out with no
 * body, a deploy gate cannot tell "degraded" from "crashed", and a CI readiness
 * loop gives up before the app ever gets to report on itself. `lib/db.ts` bounds
 * connect+query, but this route keeps its OWN independent ceiling so that
 * contract holds even if those are tuned upward for a slow region.
 * `db_latency_ms`/`db_error` make a slow-but-alive database distinguishable from
 * an absent one in the log line.
 */

/** Hard ceiling for the whole probe, overridable for slow regions. */
function probeBudgetMs(): number {
  const raw = Number(process.env.HEALTH_DB_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3_000;
}

/**
 * Identity of the process answering this probe.
 *
 * A port can outlive the run that opened it: an orphaned server from an earlier
 * start keeps listening and keeps answering 200, so a smoke check, an e2e run or
 * a human browsing can all be talking to a process that is serving a DIFFERENT,
 * older build than the one just deployed — and every conclusion drawn from it is
 * about stale code. `build_id` changes with every `next build`, so comparing it
 * against the expected build (or simply against a second probe) makes that
 * situation visible instead of silent; `pid` and `started_at` distinguish two
 * servers that share a build.
 */
const BOOT_TIME = Date.now();

const BUILD_ID: string = (() => {
  try {
    return readFileSync(".next/BUILD_ID", "utf8").trim() || "unknown";
  } catch {
    // `next dev`, or a deploy target that does not ship the file — not an error.
    return process.env.VERCEL_DEPLOYMENT_ID || "unknown";
  }
})();

type DbProbe = { state: "up" | "down"; latencyMs: number; error?: string };

async function probeDb(budgetMs: number): Promise<DbProbe> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // `getPool()` throws synchronously when DATABASE_URL is unset — that is a
    // legitimate "down" (misconfigured), so it stays inside the try.
    const ping = getPool().query("select 1");
    // Never let the losing promise surface as an unhandled rejection: the pool
    // may reject it after the race is already decided.
    void Promise.resolve(ping).catch(() => {});
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`db probe exceeded ${budgetMs}ms`)),
        budgetMs,
      );
    });
    await Promise.race([ping, budget]);
    return { state: "up", latencyMs: Date.now() - started };
  } catch (err) {
    return {
      state: "down",
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET() {
  const db = await probeDb(probeBudgetMs());

  const email: "configured" | "unconfigured" =
    process.env.RESEND_API_KEY && process.env.INVITE_FROM_EMAIL
      ? "configured"
      : "unconfigured";

  // Whether anyone can sign in on this deployment (see `authConfigured`).
  // Informational for the same reason `email` is: the app boots and serves its
  // public pages without it, and a hard 503 here would take every readiness loop
  // that gates on this probe — scripts/dev.mjs, the CI smoke step — down with it
  // on any environment that legitimately has no auth service. It is reported so
  // that "the login page renders but nobody can get in" is observable from
  // outside the process, which is the state it exists to make visible.
  const auth: "configured" | "unconfigured" = authConfigured()
    ? "configured"
    : "unconfigured";

  const ok = db.state === "up";

  return NextResponse.json(
    {
      status: ok ? "ok" : "degraded",
      ok,
      service: "alpha-crm",
      db: db.state,
      db_latency_ms: db.latencyMs,
      // Present only when down — a reason the operator can act on.
      ...(db.error ? { db_error: db.error } : {}),
      email,
      auth,
      // The full capability picture (lib/capabilities.ts). `email` and `auth`
      // above are kept as top-level fields because deploy smoke checks and
      // monitors already read them; this is the superset, and the only place a
      // gap like "no CRON_SECRET, so nothing drains the task queue" is visible
      // from outside the process. Gaps carry their consequence so an operator
      // reading a probe response does not have to know what each key does.
      capabilities: capabilitySummary(),
      capability_gaps: capabilityGaps().map((c) => ({
        id: c.id,
        severity: c.severity,
        missing: c.missing,
        consequence: c.consequence,
      })),
      time: new Date().toISOString(),
      // Which process/build is actually answering — see BUILD_ID above.
      instance: {
        pid: process.pid,
        build_id: BUILD_ID,
        started_at: new Date(BOOT_TIME).toISOString(),
        uptime_s: Math.round((Date.now() - BOOT_TIME) / 1000),
      },
    },
    {
      status: ok ? 200 : 503,
      // A probe response must never be served from a cache.
      headers: { "Cache-Control": "no-store" },
    },
  );
}
