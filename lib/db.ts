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

/**
 * Bounded waits for every database interaction.
 *
 * WITHOUT these, an unreachable database does not fail — it HANGS. `pg` inherits
 * the operating system's TCP connect timeout (~21s on Windows, up to ~130s on
 * Linux), so a firewalled/misconfigured/paused Postgres (a Supabase project that
 * has gone to sleep, a missing egress rule, a stale host in DATABASE_URL) makes
 * every DB-backed route sit there with an open, silent request. The user watches
 * a blank tab, no error boundary ever renders (nothing has thrown yet), and
 * readiness probes like /api/health blow past their own budget — the app looks
 * dead rather than degraded.
 *
 * Bounding the wait converts that indefinite hang into a prompt, catchable
 * error: the route throws, `error.tsx` renders a real message, and /api/health
 * reports 503 quickly enough for a monitor or deploy gate to act on it.
 *
 * All are overridable per environment (a cold serverless region may need a
 * longer connect budget than a VM next to the database).
 *
 * Also used for the non-millisecond positive integers below (pool size, retry
 * count) — hence the neutral name; the validation is identical either way.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  // Ignore junk/negative values rather than silently disabling the bound.
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Lazily-created singleton pool. Reads `DATABASE_URL` on first use. */
export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL is not set. Configure it in the environment (see .env.example).",
      );
    }
    pool = new Pool({
      connectionString,
      // Per-PROCESS ceiling, which on Vercel means per serverless INSTANCE — and
      // that is the whole subtlety. The pooler this app talks to enforces a
      // GLOBAL cap (Supabase session mode: `pool_size: 15` for the entire
      // project), so the effective limit is `max` × however many instances happen
      // to be warm, not `max`.
      //
      // At the previous value of 10 that arithmetic broke in production. One
      // member-portal render fans out 7 concurrent `withTenantContext` calls (see
      // app/portal/page.tsx), each taking its own connection, so a SINGLE instance
      // could hold 7-10 slots and two concurrent instances exceeded 15. The pooler
      // then rejects with a FATAL `(EMAXCONNSESSION) max clients reached in
      // session mode`, the page throws, and the member gets the error boundary —
      // which is precisely how the portal and dashboard came to be reported as
      // "implemented but not live".
      //
      // 3 keeps several instances (plus the boot-time migrate/seed children, which
      // open their own connections) comfortably inside the global cap. Queries are
      // short, so a page wanting more than 3 at once just queues on `pg`'s own
      // waitlist for a few milliseconds instead of failing. DB_POOL_MAX raises it
      // for a deployment with a bigger pooler budget or a direct connection.
      max: envInt("DB_POOL_MAX", 3),
      // Fail fast when the server is unreachable instead of inheriting the OS
      // TCP timeout. This is the bound that stops routes hanging indefinitely.
      connectionTimeoutMillis: envInt("DB_CONNECT_TIMEOUT_MS", 5_000),
      // Recycle idle clients so a pooler that silently drops them is not
      // rediscovered as a stall on the next request.
      idleTimeoutMillis: envInt("DB_IDLE_TIMEOUT_MS", 30_000),
      // A connection that established but then stops responding mid-query is
      // just as fatal as one that never connected; bound the query too.
      statement_timeout: envInt("DB_STATEMENT_TIMEOUT_MS", 15_000),
      query_timeout: envInt("DB_QUERY_TIMEOUT_MS", 15_000),
    });
    // Boot/runtime resilience: `pg` emits an 'error' event on the POOL whenever a
    // backend or network error hits an *idle* pooled client — e.g. Supabase's
    // pooler dropping an idle connection, a transient network blip, or the DB
    // being unreachable at boot. Node's EventEmitter THROWS an unhandled 'error'
    // event as an uncaughtException, which would crash the whole Next.js server
    // (taking down every route, including the static landing page) even though
    // the triggering query was already handled elsewhere. Attaching a listener
    // turns that fatal crash into a logged, swallowed event: the pool discards the
    // broken client and lazily reconnects on the next query. This changes nothing
    // about the security model — RLS, JWT-derived identity, and tenant isolation
    // are all enforced per-transaction in `withTenantContext` regardless.
    pool.on("error", (err) => {
      console.error("[db] idle pool client error (recovered, non-fatal):", err);
    });
  }
  return pool;
}

/**
 * Whether a failed `connect()` is the POOLER refusing a slot rather than a real
 * fault. Supabase's session-mode pooler reports exhaustion as a FATAL
 * `(EMAXCONNSESSION) max clients reached in session mode`; a direct Postgres
 * reports `too many clients already` (SQLSTATE 53300). Both mean "no slot right
 * now", which is transient by nature — a slot frees as soon as any other request
 * commits.
 */
export function isPoolExhaustion(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = String((err as { code?: unknown }).code ?? "");
  const message = String((err as { message?: unknown }).message ?? "");
  return (
    code === "53300" ||
    message.includes("EMAXCONNSESSION") ||
    message.includes("max clients reached") ||
    message.includes("too many clients")
  );
}

/** Resolve after `ms`. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire a pooled client, retrying briefly while the POOLER (not this pool) is
 * out of slots.
 *
 * `max` bounds how many connections THIS process asks for, but the cap that
 * actually rejects is global across every warm instance, so no local setting can
 * rule out a burst arriving while the pooler is momentarily full. Left unhandled
 * that surfaces as a rendered error page for a request that would have succeeded
 * had it waited ~50ms — the difference between "the portal is broken" and "the
 * portal was busy".
 *
 * `pg`'s own `connectionTimeoutMillis` does NOT cover this: the pooler ACTIVELY
 * REFUSES the connection, so the attempt fails immediately rather than waiting,
 * and there is nothing for that timeout to bound.
 *
 * Deliberately short and bounded: a few quick attempts, then the original error
 * propagates, so a genuinely saturated database still fails fast and visibly (and
 * /api/health still reports it) instead of holding requests open.
 */
async function connectWithRetry(): Promise<PoolClient> {
  const attempts = Math.max(1, envInt("DB_CONNECT_RETRIES", 4));
  const backoff = envInt("DB_CONNECT_RETRY_DELAY_MS", 60);
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await getPool().connect();
    } catch (err) {
      lastErr = err;
      if (!isPoolExhaustion(err) || attempt === attempts - 1) throw err;
      // Linear backoff plus jitter, so concurrent losers do not all retry on the
      // same tick and re-collide.
      await pause(backoff * (attempt + 1) + Math.floor(Math.random() * backoff));
    }
  }
  throw lastErr;
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

  const client = await connectWithRetry();
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
  const client = await connectWithRetry();
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
