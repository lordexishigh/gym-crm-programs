-- 0012_member_extended_fields.sql
-- (Renumbered from 0003_member_extended_fields.sql to resolve a duplicate `0003_`
--  prefix — see scripts/migrate.mjs RENAMED for the safe re-apply-free backfill.
--  Depends only on member/users from 0001, so its position is unaffected.)
--
-- Alpha task: full member records, search, and filtering.
--
-- Extends the minimal MVP member record with extra contact details and a
-- free-form notes field, and adds an append-only audit log of membership-status
-- changes (the "edit history of status" the detail view shows). The audit table
-- follows the same tenant-consistency + RLS conventions as the rest of the
-- schema: a composite FK keeps each event in the same gym as its member, and a
-- staff-only RLS policy scopes reads/writes to the current tenant.

-- ---------------------------------------------------------------------------
-- Extended member fields (both optional; the column stays nullable).
alter table member add column if not exists phone text;
alter table member add column if not exists notes text;

-- ---------------------------------------------------------------------------
-- member_status_event: append-only history of membership-status changes.
-- old_status is null for the very first event (member creation).
create table if not exists member_status_event (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references gym(id) on delete cascade,
  member_id   uuid not null,
  old_status  text,
  new_status  text not null,
  changed_by  uuid,
  changed_at  timestamptz not null default now(),
  -- Tenant-consistent FKs: an event's member/author must be in the same gym.
  constraint status_event_member_fk
    foreign key (member_id, tenant_id) references member (id, tenant_id) on delete cascade,
  constraint status_event_author_fk
    foreign key (changed_by, tenant_id) references users (id, tenant_id) on delete set null (changed_by)
);
create index if not exists idx_status_event_member on member_status_event (member_id, changed_at desc);
create index if not exists idx_status_event_tenant on member_status_event (tenant_id);

-- ---------------------------------------------------------------------------
-- RLS: staff-only, tenant scoped. Members never read the audit log.
alter table member_status_event enable row level security;
alter table member_status_event force  row level security;

drop policy if exists status_event_staff_all on member_status_event;
create policy status_event_staff_all on member_status_event
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

grant select, insert, update, delete on member_status_event to app_user;
