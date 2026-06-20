import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

// Always evaluated at request time so deploy smoke checks reflect live state.
export const dynamic = "force-dynamic";

/**
 * Liveness/readiness probe used by deploy pipelines and uptime checks.
 * The database ping is best-effort and never throws, so the route stays
 * reachable even when the DB is down (it reports `db: "down"` instead).
 */
export async function GET() {
  let db: "up" | "down" = "down";
  try {
    await getPool().query("select 1");
    db = "up";
  } catch {
    db = "down";
  }

  return NextResponse.json({
    status: "ok",
    service: "alpha-crm",
    db,
    time: new Date().toISOString(),
  });
}
