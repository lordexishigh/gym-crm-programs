-- 0006_gdpr_subjects.sql
-- GDPR data-subject rights, part 2 (beta-gdpr-001/002): make STAFF a
-- first-class data subject alongside members, for both export and erasure.
--
-- Migration 0004 modelled the data subject as a member only (gdpr_audit_event
-- .subject_member_id, member.erased_at). Staff (`users`) are data subjects too
-- — they can request export/erasure of their own personal data — so this
-- migration adds the symmetric pieces:
--   1. users.erased_at                 - erasure marker on a staff row (the row
--                                        is anonymised, not deleted, so the FKs
--                                        from program/assignment/invite/audit
--                                        that reference it stay intact).
--   2. gdpr_audit_event.subject_user_id - records a staff data subject, so a
--                                        staff export/erasure is auditable the
--                                        same way a member's is.
--
-- Idempotent: safe to run against a fresh or an existing database. Follows the
-- tenant-consistency + RLS conventions of 0001/0002/0004.

-- ---------------------------------------------------------------------------
-- 1. Erasure marker on the staff row.
alter table users add column if not exists erased_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Staff subject on the audit log. Tenant-consistent FK to users(id,
--    tenant_id), ON DELETE SET NULL so the audit row outlives the staff row it
--    refers to (the audit trail must survive later cleanup).
alter table gdpr_audit_event add column if not exists subject_user_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'gdpr_audit_subject_user_fk'
  ) then
    alter table gdpr_audit_event
      add constraint gdpr_audit_subject_user_fk
      foreign key (subject_user_id, tenant_id) references users (id, tenant_id)
      on delete set null (subject_user_id);
  end if;
end
$$;

create index if not exists idx_gdpr_audit_subject_user
  on gdpr_audit_event (subject_user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Re-assert the member self-insert policy, now also forbidding a member from
-- attaching a staff subject to their own self-service export event. (Members
-- still cannot read the audit log; this is defence-in-depth on the write path.)
drop policy if exists gdpr_audit_member_insert on gdpr_audit_event;
create policy gdpr_audit_member_insert on gdpr_audit_event
  for insert
  with check (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and action = 'export'
    and actor_role = 'member'
    and subject_member_id = app_current_member()
    and subject_user_id is null
  );
