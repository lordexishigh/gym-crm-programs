-- 0003_assignment_lifecycle.sql
-- Multi-program lifecycle: one ACTIVE program per member, many ARCHIVED.
--
-- The MVP modelled assignments with a status column ('active'|'archived', see
-- 0001) but never enforced that a member has at most one active program at a
-- time. This task (alpha-program-lifecycle-001) makes that invariant a
-- server-side guarantee, enforced by the database itself — re-assigning a
-- different program archives the previously-active one, and a partial unique
-- index makes a second active row for the same member impossible by
-- construction (the same belt-and-RLS philosophy as the rest of the schema).
--
-- Idempotent: safe to run against a fresh or an existing database.

-- ---------------------------------------------------------------------------
-- 1. Back-fill: collapse any pre-existing multi-active state.
-- Existing data may have several active assignments per member (the MVP allowed
-- it). Keep only the most recently assigned active row per (tenant, member) and
-- archive the rest, so the unique index below can be created without error.
-- Tie-break on id makes the choice deterministic when assigned_at is equal.
update program_assignment pa
   set status = 'archived'
 where pa.status = 'active'
   and exists (
     select 1
       from program_assignment other
      where other.tenant_id = pa.tenant_id
        and other.member_id = pa.member_id
        and other.status = 'active'
        and (other.assigned_at, other.id) > (pa.assigned_at, pa.id)
   );

-- ---------------------------------------------------------------------------
-- 2. Enforce "at most one active program per member" at the DB level.
-- A PARTIAL unique index only constrains active rows, so a member can still
-- accumulate any number of archived rows (their program history).
create unique index if not exists uq_assignment_one_active_per_member
  on program_assignment (tenant_id, member_id)
  where status = 'active';

-- Supports the member-portal history lookup (archived rows by member, newest
-- first) and the staff "is this program still active for anyone" check.
create index if not exists idx_assignment_member_status
  on program_assignment (tenant_id, member_id, status);
