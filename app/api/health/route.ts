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
 */
export async function GET() {
  let db: "up" | "down" = "down";
  try {
    await getPool().query("select 1");
    db = "up";
  } catch {
    db = "down";
  }

  const email: "configured" | "unconfigured" =
    process.env.RESEND_API_KEY && process.env.INVITE_FROM_EMAIL
      ? "configured"
      : "unconfigured";

  const ok = db === "up";

  return NextResponse.json(
    {
      status: ok ? "ok" : "degraded",
      ok,
      service: "alpha-crm",
      db,
      email,
      time: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}
