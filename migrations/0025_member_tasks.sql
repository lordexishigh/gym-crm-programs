-- 0025_member_tasks.sql
--
-- (Renumbered from 0013 on 2026-08-14: authored before
-- 0013_member_safety_and_status_fields.sql landed and shared its prefix, which
-- test/migration-filenames.test.ts rejects because migrate.mjs applies files in
-- filename order. Safe to renumber rather than alias — this file has never been
-- applied anywhere, so no schema_migrations row refers to the old name.)
-- Trainer follow-up tasks / reminders on a member (CRM-IDEAS "Apply now" #5).
--
-- A lightweight HubSpot-style task a trainer leaves on a member ("check in with
-- X by Friday"), closing the loop after the roster at-risk signal flags someone.
-- Staff-only and tenant-scoped, following the same conventions as
-- member_status_event (0012): a composite FK keeps each task in the same gym as
-- its member, and a single `for all` RLS policy scopes every read/write to the
-- current tenant's staff. Members never see or write these — they are an
-- internal trainer tool, not member-facing data.

create table if not exists member_task (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references gym(id) on delete cascade,
  member_id    uuid not null,
  title        text not null,
  due_at       timestamptz,
  completed_at timestamptz,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  -- Tenant-consistent FKs: a task's member/author must be in the same gym.
  constraint member_task_member_fk
    foreign key (member_id, tenant_id) references member (id, tenant_id) on delete cascade,
  constraint member_task_author_fk
    foreign key (created_by, tenant_id) references users (id, tenant_id) on delete set null (created_by)
);
create index if not exists idx_member_task_tenant on member_task (tenant_id);
-- The member-detail list and the "due today / overdue" view both filter by
-- member and sort open tasks by due date.
create index if not exists idx_member_task_member
  on member_task (tenant_id, member_id, due_at);

-- ---------------------------------------------------------------------------
-- Row Level Security. A new tenanted table must enable + force RLS itself (the
-- auto-discovery audit in test/isolation-coverage.test.ts fails CI otherwise).
alter table member_task enable row level security;
alter table member_task force  row level security;

drop policy if exists member_task_staff_all on member_task;
create policy member_task_staff_all on member_task
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

grant select, insert, update, delete on member_task to app_user;
