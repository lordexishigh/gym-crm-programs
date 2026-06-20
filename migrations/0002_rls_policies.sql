-- 0002_rls_policies.sql
-- Row Level Security: tenant isolation + per-member row scoping.
--
-- Identity is read from transaction-local session GUCs that the application
-- sets from the server-verified JWT (see lib/db.ts withTenantContext):
--   app.tenant_id  uuid  - current gym/tenant
--   app.role       text  - 'staff' | 'member'
--   app.member_id  uuid  - current member (member sessions only)
--
-- Scoped queries run as the non-owner, non-superuser role `app_user`, so RLS
-- applies. FORCE ROW LEVEL SECURITY is also set as defense-in-depth so the
-- table owner is subject to RLS too. Superuser / migration connections still
-- bypass RLS by design (used only for provisioning and these migrations).

-- ---------------------------------------------------------------------------
-- Identity helper functions (STABLE; read transaction-local GUCs).
create or replace function app_current_tenant() returns uuid
  language sql stable as $$
    select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

create or replace function app_current_role() returns text
  language sql stable as $$
    select coalesce(nullif(current_setting('app.role', true), ''), 'none')
$$;

create or replace function app_current_member() returns uuid
  language sql stable as $$
    select nullif(current_setting('app.member_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Enable + force RLS on every tenanted table.
alter table gym                enable row level security;
alter table gym                force  row level security;
alter table users              enable row level security;
alter table users              force  row level security;
alter table member             enable row level security;
alter table member             force  row level security;
alter table invite             enable row level security;
alter table invite             force  row level security;
alter table program            enable row level security;
alter table program            force  row level security;
alter table exercise           enable row level security;
alter table exercise           force  row level security;
alter table program_assignment enable row level security;
alter table program_assignment force  row level security;

-- ---------------------------------------------------------------------------
-- Policies. Multiple PERMISSIVE policies are OR-ed; with no matching policy a
-- row is denied (deny-by-default once RLS is enabled). `drop policy if exists`
-- keeps this migration idempotent.

-- gym: a session can see only its own gym; staff may update it.
drop policy if exists gym_select on gym;
create policy gym_select on gym
  for select using (id = app_current_tenant());

drop policy if exists gym_staff_update on gym;
create policy gym_staff_update on gym
  for update
  using (id = app_current_tenant() and app_current_role() = 'staff')
  with check (id = app_current_tenant() and app_current_role() = 'staff');

-- users: staff-only, scoped to the tenant. (Members do not access staff rows.)
drop policy if exists users_staff_all on users;
create policy users_staff_all on users
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

-- member: staff manage all members in the tenant; a member may read ONLY
-- their own row.
drop policy if exists member_staff_all on member;
create policy member_staff_all on member
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

drop policy if exists member_self_select on member;
create policy member_self_select on member
  for select
  using (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and id = app_current_member()
  );

-- invite: staff-only, tenant-scoped (acceptance-by-token uses the admin path).
drop policy if exists invite_staff_all on invite;
create policy invite_staff_all on invite
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

-- program: staff manage all in the tenant; a member may read a program ONLY if
-- it is assigned to them.
drop policy if exists program_staff_all on program;
create policy program_staff_all on program
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

drop policy if exists program_member_select on program;
create policy program_member_select on program
  for select
  using (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and exists (
      select 1 from program_assignment pa
      where pa.program_id = program.id
        and pa.member_id = app_current_member()
    )
  );

-- exercise: staff manage all in the tenant; a member may read exercises of a
-- program assigned to them.
drop policy if exists exercise_staff_all on exercise;
create policy exercise_staff_all on exercise
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

drop policy if exists exercise_member_select on exercise;
create policy exercise_member_select on exercise
  for select
  using (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and exists (
      select 1 from program_assignment pa
      where pa.program_id = exercise.program_id
        and pa.member_id = app_current_member()
    )
  );

-- program_assignment: staff manage all in the tenant; a member may read ONLY
-- their own assignments.
drop policy if exists assignment_staff_all on program_assignment;
create policy assignment_staff_all on program_assignment
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

drop policy if exists assignment_member_select on program_assignment;
create policy assignment_member_select on program_assignment
  for select
  using (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and member_id = app_current_member()
  );

-- ---------------------------------------------------------------------------
-- Privileges for the unprivileged app role. RLS gates WHICH rows; these grants
-- gate the DML verbs. app_user is NOT a table owner, so RLS is enforced.
grant usage on schema public to app_user;
grant select, insert, update, delete on
  gym, users, member, invite, program, exercise, program_assignment
  to app_user;
