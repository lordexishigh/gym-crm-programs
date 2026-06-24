-- 0008_workout_logs.sql
-- Member workout-session logging (Phase GA — ga-engagement-001).
--
-- The first interactive, member-WRITTEN entity: a member viewing their assigned
-- program can log that they completed a workout session, with an optional
-- perceived-effort (RPE 1-10) and a free-text note. This is the foundation of
-- the engagement feedback loop — until now the member portal was strictly
-- read-only.
--
-- Tenant isolation follows the established pattern: a tenant_id FK to gym, and
-- composite (id, tenant_id) FKs to member and program so a log can only ever
-- reference a parent in the SAME tenant (schema-level cross-tenant integrity,
-- complementing the RLS policies below). RLS — not application code — makes a
-- member's logs invisible to other members and other gyms by construction.

create table if not exists workout_log (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references gym(id) on delete cascade,
  member_id    uuid not null,
  program_id   uuid not null,
  -- When the session was completed (the member may back-date via the form, but
  -- defaults to now()). Distinct from created_at (when the row was written).
  completed_at timestamptz not null default now(),
  -- Perceived effort, RPE 1-10. Nullable: the member may skip it.
  effort       integer check (effort is null or (effort between 1 and 10)),
  note         text,
  created_at   timestamptz not null default now(),
  -- Tenant-consistent FKs: a log's member and program must be in the same gym.
  constraint workout_log_member_fk
    foreign key (member_id, tenant_id) references member (id, tenant_id) on delete cascade,
  constraint workout_log_program_fk
    foreign key (program_id, tenant_id) references program (id, tenant_id) on delete cascade
);
create index if not exists idx_workout_log_tenant on workout_log (tenant_id);
-- The member-portal history lookup: most recent sessions for one member.
create index if not exists idx_workout_log_member
  on workout_log (tenant_id, member_id, completed_at desc);
-- The (future) staff adherence lookup: sessions per program.
create index if not exists idx_workout_log_program on workout_log (tenant_id, program_id);

-- ---------------------------------------------------------------------------
-- Row Level Security. Migration 0002 enabled/forced RLS on the original core
-- tables; this is a new table so it must do so itself (the auto-discovery audit
-- in test/isolation-coverage.test.ts fails CI for any tenanted table missing
-- this). app_user is non-owner + non-superuser, so FORCE applies to it.
alter table workout_log enable row level security;
alter table workout_log force  row level security;

-- staff: READ-ONLY visibility into their own gym's member activity. Staff never
-- write a member's log (the member owns that data), so no insert/update/delete.
drop policy if exists workout_log_staff_select on workout_log;
create policy workout_log_staff_select on workout_log
  for select
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff');

-- member: read their OWN logs.
drop policy if exists workout_log_member_select on workout_log;
create policy workout_log_member_select on workout_log
  for select
  using (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and member_id = app_current_member()
  );

-- member: create a log for THEMSELVES, and only against a program currently or
-- previously assigned to them. The assignment EXISTS check is itself RLS-bound
-- (assignment_member_select scopes it to the caller), so a member cannot log a
-- session against a program that was never theirs.
drop policy if exists workout_log_member_insert on workout_log;
create policy workout_log_member_insert on workout_log
  for insert
  with check (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and member_id = app_current_member()
    and exists (
      select 1 from program_assignment pa
      where pa.program_id = workout_log.program_id
        and pa.member_id = app_current_member()
    )
  );

-- member: delete their OWN logs (undo a mistaken entry).
drop policy if exists workout_log_member_delete on workout_log;
create policy workout_log_member_delete on workout_log
  for delete
  using (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and member_id = app_current_member()
  );

-- Verb grants for the unprivileged app role (RLS gates WHICH rows; these gate
-- the DML verbs). No UPDATE: a log is immutable once written — correct an entry
-- by deleting and re-logging.
grant select, insert, delete on workout_log to app_user;
