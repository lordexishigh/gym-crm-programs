import { Pool, type PoolClient } from "pg";

/**
 * Database access with tenant/member isolation enforced at the Postgres layer.
 *
 * The connection itself is a privileged (migration/admin) role. Tenant-scoped
 * work runs inside a transaction that:
 *   1. sets transaction-local GUCs (`app.tenant_id`, `app.role`, `app.user_id`,
 *      `app.member_id`) from the *server-verified* identity, and
 *   2. drops to the non-owner `app_user` role via `SET LOCAL ROLE`.
 *
 * Because `app_user` neither owns the tables nor is a superuser, Row Level
 * Security policies apply to it and read those GUCs — so isolation holds even
 * if application query code is buggy or forgets a `WHERE tenant_id = ...`.
 *
 * The GUCs are transaction-local (`set_config(..., true)` and `SET LOCAL`), so
 * a connection returned to the pool never leaks identity into the next request.
 */

export type Identity = {
  /** Gym (tenant) id — required for every scoped query. */
  tenantId: string;
  /** Which audience the session belongs to. */
  role: "staff" | "member";
  /** Staff user id (present for staff sessions). */
  userId?: string | null;
  /** Member id (present for member sessions; enables per-member row scoping). */
  memberId?: string | null;
};

let pool: Pool | null = null;

/** Lazily-created singleton pool. Reads `DATABASE_URL` on first use. */
export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL is not set. Configure it in the environment (see .env.example).",
      );
    }
    pool = new Pool({ connectionString, max: 10 });
  }
  return pool;
}

/** Close the pool (used by tests / graceful shutdown). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Run `fn` inside a transaction scoped to `identity`, as the RLS-bound
 * `app_user` role. All reads/writes are constrained by RLS policies to the
 * caller's tenant (and, for members, to their own rows).
 */
export async function withTenantContext<T>(
  identity: Identity,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!identity.tenantId) {
    throw new Error("withTenantContext requires a tenantId.");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Set identity GUCs (transaction-local) BEFORE dropping role, then switch
    // to the unprivileged, RLS-bound role for the rest of the transaction.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      identity.tenantId,
    ]);
    await client.query("SELECT set_config('app.role', $1, true)", [
      identity.role,
    ]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [
      identity.userId ?? "",
    ]);
    await client.query("SELECT set_config('app.member_id', $1, true)", [
      identity.memberId ?? "",
    ]);
    await client.query("SET LOCAL ROLE app_user");

    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` as the privileged connection role WITHOUT a tenant context — used
 * only for provisioning/admin paths that must legitimately cross tenants
 * (e.g. creating a gym, invite-token lookup before a session exists).
 *
 * DANGER: this path is NOT constrained by RLS. Keep its callers tightly
 * scoped and audited; never route normal request handling through it.
 */
export async function withAdminContext<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
