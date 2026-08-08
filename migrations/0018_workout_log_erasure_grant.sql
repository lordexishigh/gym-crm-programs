-- 0018_workout_log_erasure_grant.sql
--
-- Bug fix: GDPR erasure crashed with `permission denied for table workout_log`.
--
-- `anonymiseMember` (lib/gdpr/export.ts) scrubs the free-text `note` on a
-- member's workout logs, because a member-authored note can contain PII and an
-- erasure that leaves it behind is not an erasure. That statement is
--
--     update workout_log set note = null where member_id = $1
--
-- but 0008 deliberately granted only `select, insert, delete` on workout_log to
-- app_user ("a log is immutable once written"), and defined no UPDATE policy.
-- So the erasure path failed outright — it is the red step in the Deploy /
-- CI `test` job, which in turn blocks the production-migration step.
--
-- The immutability rule is still the right one, so this does NOT open the table
-- up to general updates. Two narrow changes instead:
--
--   1. A COLUMN-level update grant on `note` only. Every other column
--      (effort, member_id, program_id, logged_at, …) remains non-updatable at
--      the privilege level, so an immutability violation is rejected by
--      Postgres rather than by convention. This is the smallest grant that
--      makes the erasure work.
--   2. A staff-scoped UPDATE policy, since FORCE row level security is on and
--      an UPDATE with no permissive policy silently matches zero rows — which
--      would have left the PII in place while *appearing* to succeed. Erasure
--      is an operator action (app/dashboard/members/actions.ts), so staff-only
--      matches the caller; members still cannot rewrite their own log notes.
--
-- Idempotent: the grant is a no-op if already held, and the policy is dropped
-- before being recreated (matching the convention in 0008/0014-0017).

-- 1. Column-level UPDATE privilege — `note` and nothing else.
grant update (note) on workout_log to app_user;

-- 2. Staff may update (only ever `note`, per the grant above) within their own
--    tenant. The matching WITH CHECK keeps the row inside the tenant afterwards
--    so a row can never be moved across gyms.
drop policy if exists workout_log_staff_note_update on workout_log;
create policy workout_log_staff_note_update on workout_log
  for update
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');
