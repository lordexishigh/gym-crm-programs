-- 0020_task_queue.sql
--
-- A durable, leased work queue — the substrate every scheduled job in this
-- codebase currently lacks.
--
-- The concrete bug this fixes: `scripts/notify-membership-expiry.mjs` selects
-- every active plan whose `current_period_end` falls in the next 7 days and
-- emails each one, with NO record that it did. Its scheduler
-- (.github/workflows/membership-expiry.yml) runs it daily. So a membership
-- expiring on the 8th is inside the window on the 1st, 2nd, 3rd … 7th, and the
-- member is emailed SEVEN times about one renewal. Nothing in the script can
-- detect that, because "already sent" was never written down anywhere.
--
-- Note the contrast with 0019_waitlist_promotion.sql, which got this right for
-- one feature: it added `promotion_notified_at` precisely so "any retry of the
-- promotion path could email the same member repeatedly" stopped being true.
-- That fix was per-feature and non-reusable — a second column on a second
-- table. This table generalises it: any job that must happen once gets a row
-- whose uniqueness IS the guard, so the next scheduled job does not have to
-- re-derive the same lesson.
--
-- Design, and why each part is load-bearing:
--
--   dedupe_key + the unique index below.  `enqueue()` (lib/tasks.ts) inserts
--     with `on conflict do nothing`, so enqueueing is idempotent and the
--     CALLER no longer needs to be. A daily sweep can re-enqueue the same
--     reminder every day for a week and exactly one email is sent. The key is
--     supplied by the caller and must encode the occasion, not just the
--     subject — `<member_plans.id>:<period_end date>` dedupes this renewal
--     while still allowing next period's, which is a different occasion and
--     therefore a different key.
--
--   due_at instead of cron.  Scheduling is data, not configuration: a task
--     that should happen in three days is a row with `due_at = now() +
--     interval '3 days'`. One dispatcher drains everything due, so adding a
--     new kind of scheduled work needs no new scheduler, no new workflow file,
--     and no new deploy target. This matters here more than it would in most
--     projects: GitHub Actions is the only scheduler currently wired up and it
--     has been failing on a billing limit since 2026-07-30, so
--     `membership-expiry.yml` has in practice never run. A single Vercel cron
--     hitting /api/tasks/dispatch replaces it and every future one.
--
--   leased_until + FOR UPDATE SKIP LOCKED.  Two dispatchers (a cron overlapping
--     its own previous run, or a retry firing while the first attempt is still
--     in flight) take DISJOINT work rather than both processing the same row:
--     `SKIP LOCKED` means the second claimer steps over what the first has
--     locked instead of blocking on it. The lease is what makes a crash safe —
--     a run that dies mid-task leaves the row leased, not lost, and it becomes
--     claimable again the moment the lease expires. Without the lease a
--     killed dispatcher would strand its tasks in 'pending' forever while
--     appearing to hold them.
--
--   attempts/max_attempts/last_error.  A task that fails is retried with
--     backoff and then parked at 'failed' with the reason attached, so a
--     permanently-broken task stops burning dispatcher budget on every run but
--     stays visible for a human. Silent infinite retry is how a queue turns
--     into an outage.
--
-- Retention: rows are kept after completion so the dedupe guarantee survives
-- (a deleted row is a re-send waiting to happen), and pruned on the same
-- schedule as the rest of our data by `pruneCompletedTasks` (lib/retention.ts).
-- The prune window is deliberately longer than the longest dedupe window in
-- use.

create table if not exists tasks (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references gym(id) on delete cascade,
  -- Which handler runs this. Not a CHECK constraint: handlers are registered in
  -- application code (lib/task-handlers.ts) and a DB-level enum would make
  -- adding one a migration, which is exactly the friction this table exists to
  -- remove. An unknown kind is parked as 'failed' with a clear reason rather
  -- than silently dropped.
  kind          text not null,
  -- The occasion this task represents. Unique per (tenant, kind) — see the
  -- index below. Callers build it with `dedupeKey()` in lib/tasks.ts.
  dedupe_key    text not null,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'pending'
                  check (status in ('pending', 'done', 'failed')),
  due_at        timestamptz not null default now(),
  -- Held by whichever dispatcher claimed the row; null when unclaimed. A row
  -- whose lease is in the past is claimable again even though it is still
  -- 'pending' — that is the crash-recovery path.
  leased_until  timestamptz,
  attempts      integer not null default 0,
  max_attempts  integer not null default 5,
  last_error    text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

-- The idempotency guarantee, enforced by the database rather than by every
-- caller remembering to check first.
create unique index if not exists idx_tasks_dedupe
  on tasks (tenant_id, kind, dedupe_key);

-- The claim query's index. Partial and therefore tiny: it holds only work still
-- waiting, which for a healthy queue is close to zero rows, so claiming stays
-- fast no matter how much completed history accumulates. Deliberately NOT
-- prefixed with tenant_id — the dispatcher drains every tenant's due work in one
-- pass and must not be forced into a per-tenant scan.
create index if not exists idx_tasks_claimable
  on tasks (due_at)
  where status = 'pending';

-- Staff-facing queue visibility ("is the reminder for this member queued?") is
-- per-tenant and ordered by recency.
create index if not exists idx_tasks_tenant_created
  on tasks (tenant_id, created_at desc);

alter table tasks enable row level security;
alter table tasks force  row level security;

-- Staff may READ their own gym's queue — enough for a dashboard to show what is
-- scheduled or stuck, which is the difference between a queue and a black box.
--
-- There is deliberately no staff INSERT/UPDATE/DELETE policy. Tasks are
-- enqueued and drained by server-side code on the admin path (see below), never
-- by a browser session: a staff-writable queue would let a gym schedule
-- arbitrary `kind`s with arbitrary payloads, which is a code-execution-shaped
-- surface pointed straight at our own handlers. Read-only is all the UI needs.
drop policy if exists tasks_staff_select on tasks;
create policy tasks_staff_select on tasks
  for select
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff');

-- Members get no policy at all, so RLS denies them every row. The queue is
-- staff/system infrastructure; its payloads reference other members.

grant select on tasks to app_user;

-- Enqueue and claim run through `withAdminContext` (lib/db.ts), the privileged
-- non-RLS path, because both are legitimately cross-tenant: one dispatcher
-- drains the whole queue and has no tenant session to run under. This is the
-- same narrowly-scoped admin pattern as invite-token lookup
-- (lib/invite-acceptance.ts) and waitlist promotion (lib/classes.ts) — and the
-- boundary is kept tight the same way: claiming is cross-tenant, but every
-- handler then does its actual data access inside `withTenantContext` under the
-- owning tenant's identity, so a handler bug cannot read across gyms.

comment on table tasks is
  'Durable leased work queue. Uniqueness on (tenant_id, kind, dedupe_key) makes enqueueing idempotent; due_at replaces cron; leased_until + FOR UPDATE SKIP LOCKED make concurrent dispatch and crash recovery safe.';
comment on column tasks.dedupe_key is
  'The occasion this task represents, unique per (tenant, kind). Must encode the occasion and not merely the subject, so a recurring reminder dedupes within one period but not across periods.';
comment on column tasks.leased_until is
  'Claim expiry held by the dispatcher processing this row. A lease in the past means the claimer died and the row is claimable again.';
comment on column tasks.max_attempts is
  'Retry ceiling. On the final failure the row is parked at status=failed with last_error set, rather than retried forever.';
