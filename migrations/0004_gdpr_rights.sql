-- 0004_gdpr_rights.sql
-- GDPR data-subject rights (beta-gdpr-001/002): export, erasure, retention.
--
-- Three additions, all following the established tenant-consistency + RLS
-- conventions (see 0001/0002):
--   1. member.erased_at      - marks an anonymised (right-to-erasure) member, so
--                              the state is queryable and erasure is idempotent.
--   2. gym.data_retention_days - per-tenant retention override (null = platform
--                              default from the DATA_RETENTION_DAYS env). Makes
--                              retention behaviour CONFIGURABLE per gym.
--   3. gdpr_audit_event      - append-only audit log of export/erasure actions,
--                              so every data-subject request is recorded.
--
-- Idempotent: safe to run against a fresh or an existing database.

-- ---------------------------------------------------------------------------
-- 1. Erasure marker on member (kept in place; the row is anonymised, not
--    deleted, so referential integrity with assignments/events is preserved).
alter table member add column if not exists erased_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Per-tenant retention override (null → fall back to the platform default).
alter table gym add column if not exists data_retention_days integer
  check (data_retention_days is null or data_retention_days >= 1);

-- ---------------------------------------------------------------------------
-- 3. gdpr_audit_event: append-only record of data-subject requests.
-- action  - 'export' | 'erasure'
-- actor_role - who performed it ('staff' | 'member'); a member may self-export.
-- actor_user_id - the staff users(id) when staff-initiated (null for member self
--              service / system jobs).
-- subject_member_id - the data subject the action concerned.
-- detail  - free-form jsonb (e.g. exported record counts) for the audit trail.
create table if not exists gdpr_audit_event (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references gym(id) on delete cascade,
  action            text not null check (action in ('export', 'erasure')),
  actor_role        text not null check (actor_role in ('staff', 'member')),
  actor_user_id     uuid,
  subject_member_id uuid,
  detail            jsonb,
  created_at        timestamptz not null default now(),
  -- Tenant-consistent FKs: actor/subject must belong to the same gym. Both are
  -- ON DELETE SET NULL so the audit row survives later erasure/cleanup of the
  -- referenced rows (the audit trail must outlive what it records).
  constraint gdpr_audit_actor_fk
    foreign key (actor_user_id, tenant_id) references users (id, tenant_id) on delete set null (actor_user_id),
  constraint gdpr_audit_subject_fk
    foreign key (subject_member_id, tenant_id) references member (id, tenant_id) on delete set null (subject_member_id)
);
create index if not exists idx_gdpr_audit_tenant on gdpr_audit_event (tenant_id, created_at desc);
create index if not exists idx_gdpr_audit_subject on gdpr_audit_event (subject_member_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS: staff manage/read all audit rows in their tenant; a member may INSERT
-- (only) an export event for THEMSELVES (their self-service download is logged).
-- Members never read the audit log.
alter table gdpr_audit_event enable row level security;
alter table gdpr_audit_event force  row level security;

drop policy if exists gdpr_audit_staff_all on gdpr_audit_event;
create policy gdpr_audit_staff_all on gdpr_audit_event
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

drop policy if exists gdpr_audit_member_insert on gdpr_audit_event;
create policy gdpr_audit_member_insert on gdpr_audit_event
  for insert
  with check (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and action = 'export'
    and actor_role = 'member'
    and subject_member_id = app_current_member()
  );

-- ---------------------------------------------------------------------------
-- Privileges for the unprivileged app role (RLS still gates the rows).
grant select, insert, update, delete on gdpr_audit_event to app_user;
