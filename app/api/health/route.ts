import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

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
      time: new Date().toISOString(),
    },
    {
      status: ok ? 200 : 503,
      // A probe response must never be served from a cache.
      headers: { "Cache-Control": "no-store" },
    },
  );
}
