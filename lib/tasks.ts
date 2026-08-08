import { withAdminContext } from "@/lib/db";

/**
 * Durable leased work queue (migration 0020).
 *
 * Replaces the "select rows, act on each, remember nothing" shape that every
 * scheduled job in this codebase used before it — see the migration header for
 * the seven-emails-per-renewal bug that shape produced.
 *
 * Three guarantees, each earned by a specific piece of the schema:
 *
 *   Enqueueing is idempotent.  `enqueue` inserts `on conflict do nothing`
 *     against the unique `(tenant_id, kind, dedupe_key)` index, so a sweep may
 *     run as often as it likes. Callers stop needing an "already done?" check,
 *     which is the check they kept forgetting.
 *
 *   Claiming is exclusive.  `claimDue` leases rows with `FOR UPDATE SKIP
 *     LOCKED`, so two dispatchers take disjoint work instead of both processing
 *     the same row, and a dispatcher that dies mid-task leaves its rows leased
 *     rather than lost — they become claimable again when the lease expires.
 *
 *   Failure is bounded and visible.  Attempts are counted AT CLAIM TIME (see
 *     `claimDue`), retried with exponential backoff, and parked at 'failed'
 *     with the reason attached once the ceiling is reached.
 *
 * Why the admin path: one dispatcher drains every tenant's due work and has no
 * tenant session to run under, so enqueue/claim go through `withAdminContext`
 * (lib/db.ts) — the same narrowly-scoped, RLS-bypassing pattern as invite-token
 * lookup and waitlist promotion. The boundary stays tight because handlers
 * (lib/task-handlers.ts) do their actual data access inside
 * `withTenantContext` under the owning tenant's identity: claiming crosses
 * tenants, handling never does.
 */

/** A task's lifecycle state. Mirrors the CHECK constraint in 0020. */
export type TaskStatus = "pending" | "done" | "failed";

export type TaskRow = {
  id: string;
  tenant_id: string;
  kind: string;
  dedupe_key: string;
  payload: Record<string, unknown>;
  status: TaskStatus;
  due_at: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
};

export type EnqueueInput = {
  tenantId: string;
  kind: string;
  /** The occasion — see `dedupeKey`. */
  dedupeKey: string;
  payload?: Record<string, unknown>;
  /** Defaults to now (claimable immediately). */
  dueAt?: Date;
  /** Retry ceiling; defaults to the column default (5). */
  maxAttempts?: number;
};

/**
 * Build a dedupe key from its parts.
 *
 * The key must encode the OCCASION, not merely the subject. `member:<id>` would
 * dedupe a renewal reminder forever — the member would be reminded once and
 * never again. `member-plan:<id>:2026-09-01` dedupes this renewal while leaving
 * next period's free to enqueue, because it is a different occasion.
 *
 * Parts are joined with ':' and validated: an empty or colon-containing part
 * would silently collapse two distinct occasions into one key (or split one
 * into two), and a queue whose dedupe key is subtly wrong is worse than no
 * dedupe at all — it drops real work while looking healthy. So it throws.
 */
export function dedupeKey(...parts: Array<string | number>): string {
  if (parts.length === 0) {
    throw new Error("dedupeKey requires at least one part.");
  }
  return parts
    .map((raw, i) => {
      const part = String(raw);
      if (part.length === 0) {
        throw new Error(`dedupeKey part ${i} is empty.`);
      }
      if (part.includes(":")) {
        throw new Error(
          `dedupeKey part ${i} (${part}) contains ':', which is the separator.`,
        );
      }
      return part;
    })
    .join(":");
}

/**
 * A calendar-day stamp (UTC) for use as a dedupe-key part.
 *
 * Renewal and adherence windows are day-grained, and a timestamp would defeat
 * the whole mechanism: `due_at` differing by milliseconds between two sweeps
 * would produce two keys for one occasion and two emails for one renewal.
 */
export function dayStamp(when: Date): string {
  return when.toISOString().slice(0, 10);
}

/**
 * How long to wait before retrying a task that has failed `attempts` times.
 *
 * Exponential with a hard ceiling. The first retry is soon (a transient
 * mail-provider blip should not delay a reminder by hours) and the last is far
 * out (a genuinely broken handler should not be hammered, or burn the
 * dispatcher's per-run budget that other tenants' work needs).
 */
export function retryDelaySeconds(attempts: number): number {
  const base = 60;
  const ceiling = 6 * 60 * 60; // 6h
  const n = Math.max(1, Math.floor(attempts));
  // 60s, 5m, 25m, 2h05m, then pinned at the ceiling.
  return Math.min(base * Math.pow(5, n - 1), ceiling);
}

/** Whether a task that just failed still has attempts left. */
export function shouldRetry(attempts: number, maxAttempts: number): boolean {
  return attempts < maxAttempts;
}

/**
 * Enqueue one task, ignoring it if the same occasion is already queued or done.
 *
 * Returns true if this call created the row — useful for logging how much of a
 * sweep was new, and the signal a test asserts on to prove dedupe works.
 */
export async function enqueue(input: EnqueueInput): Promise<boolean> {
  return withAdminContext(async (c) => {
    const { rowCount } = await c.query(
      `insert into tasks (tenant_id, kind, dedupe_key, payload, due_at, max_attempts)
       values ($1, $2, $3, $4::jsonb, coalesce($5, now()), coalesce($6, 5))
       on conflict (tenant_id, kind, dedupe_key) do nothing`,
      [
        input.tenantId,
        input.kind,
        input.dedupeKey,
        JSON.stringify(input.payload ?? {}),
        input.dueAt ?? null,
        input.maxAttempts ?? null,
      ],
    );
    return (rowCount ?? 0) > 0;
  });
}

/**
 * Enqueue a batch in ONE transaction, returning how many rows were new.
 *
 * A sweep over hundreds of expiring memberships would otherwise open hundreds
 * of transactions, and `lib/db.ts` caps this process at 3 pooled connections
 * against a globally-capped pooler — so the per-row version does not merely run
 * slowly, it competes with live requests for the connections that serve them.
 */
export async function enqueueMany(inputs: EnqueueInput[]): Promise<number> {
  if (inputs.length === 0) return 0;
  return withAdminContext(async (c) => {
    let created = 0;
    for (const input of inputs) {
      const { rowCount } = await c.query(
        `insert into tasks (tenant_id, kind, dedupe_key, payload, due_at, max_attempts)
         values ($1, $2, $3, $4::jsonb, coalesce($5, now()), coalesce($6, 5))
         on conflict (tenant_id, kind, dedupe_key) do nothing`,
        [
          input.tenantId,
          input.kind,
          input.dedupeKey,
          JSON.stringify(input.payload ?? {}),
          input.dueAt ?? null,
          input.maxAttempts ?? null,
        ],
      );
      created += (rowCount ?? 0) > 0 ? 1 : 0;
    }
    return created;
  });
}

/**
 * Claim up to `limit` due tasks, leasing them for `leaseSeconds`.
 *
 * `attempts` is incremented HERE, at claim time, not when a task fails. That is
 * deliberate: a task that crashes the dispatcher (or times out the function, or
 * gets OOM-killed) never reaches a failure handler, so counting attempts on
 * failure would let a poison task retry forever — the exact hang this lease is
 * supposed to prevent. Counting on claim means every claim costs an attempt, so
 * a task that kills its worker still exhausts its budget and gets parked.
 *
 * The subquery locks with `FOR UPDATE SKIP LOCKED` so a concurrent dispatcher
 * steps over these rows rather than blocking on them.
 */
export async function claimDue(options?: {
  limit?: number;
  leaseSeconds?: number;
}): Promise<TaskRow[]> {
  const limit = Math.max(1, Math.floor(options?.limit ?? 25));
  const leaseSeconds = Math.max(1, Math.floor(options?.leaseSeconds ?? 300));

  return withAdminContext(async (c) => {
    const { rows } = await c.query(
      `update tasks t
          set leased_until = now() + make_interval(secs => $2::double precision),
              attempts = t.attempts + 1
        where t.id in (
                select id
                  from tasks
                 where status = 'pending'
                   and due_at <= now()
                   and (leased_until is null or leased_until < now())
                 order by due_at
                 limit $1
                   for update skip locked
              )
      returning t.id, t.tenant_id, t.kind, t.dedupe_key, t.payload, t.status,
                t.due_at, t.attempts, t.max_attempts, t.last_error`,
      [limit, leaseSeconds],
    );
    return rows as TaskRow[];
  });
}

/** Mark a claimed task done. Idempotent — completing twice is a no-op. */
export async function completeTask(id: string): Promise<void> {
  await withAdminContext(async (c) => {
    await c.query(
      `update tasks
          set status = 'done',
              completed_at = now(),
              leased_until = null,
              last_error = null
        where id = $1 and status = 'pending'`,
      [id],
    );
  });
}

/**
 * Record a failure: reschedule with backoff, or park at 'failed' once the
 * attempt ceiling is reached.
 *
 * The error message is stored either way, so a parked task explains itself and
 * a retrying one shows what it is retrying past.
 */
export async function failTask(
  id: string,
  error: unknown,
  attempts: number,
  maxAttempts: number,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  // Truncated: `last_error` is for a human triaging the queue, and an
  // unbounded provider stack trace would bloat every row it touches.
  const stored = message.slice(0, 1000);

  await withAdminContext(async (c) => {
    if (shouldRetry(attempts, maxAttempts)) {
      await c.query(
        `update tasks
            set due_at = now() + make_interval(secs => $2::double precision),
                leased_until = null,
                last_error = $3
          where id = $1`,
        [id, retryDelaySeconds(attempts), stored],
      );
      return;
    }
    await c.query(
      `update tasks
          set status = 'failed',
              leased_until = null,
              last_error = $2,
              completed_at = now()
        where id = $1`,
      [id, stored],
    );
  });
}

/**
 * Delete finished tasks older than `olderThanDays`.
 *
 * Completed rows are NOT disposable: while a row survives, its dedupe key keeps
 * the occasion from being re-enqueued, so deleting one is a re-send waiting to
 * happen. The prune window must therefore stay comfortably longer than the
 * longest dedupe window any handler relies on (currently the ~7-day renewal
 * reminder). 'failed' rows are pruned too, but only once they are old enough to
 * have been triaged — they are the queue's only record of what broke.
 */
export async function pruneCompletedTasks(olderThanDays = 90): Promise<number> {
  const days = Math.max(1, Math.floor(olderThanDays));
  return withAdminContext(async (c) => {
    const { rowCount } = await c.query(
      `delete from tasks
        where status in ('done', 'failed')
          and completed_at is not null
          and completed_at < now() - make_interval(days => $1::integer)`,
      [days],
    );
    return rowCount ?? 0;
  });
}
