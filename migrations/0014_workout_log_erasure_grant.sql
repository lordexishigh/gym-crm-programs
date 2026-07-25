-- 0014_workout_log_erasure_grant.sql
-- Fixes a real bug: GDPR erasure (`anonymiseMember`, beta-gdpr-002) scrubs a
-- member's workout_log free-text notes on erasure —
--   update workout_log set note = null where member_id = $1
-- — but migration 0008 deliberately granted app_user only
-- `select, insert, delete` on workout_log ("a log is immutable once written"),
-- with no UPDATE at all. Postgres checks table-level UPDATE privilege before
-- evaluating the WHERE clause, so EVERY erasure request hits
-- "permission denied for table workout_log" and fails, regardless of whether
-- the member has any logs. Right-to-erasure has been broken since the GDPR
-- feature shipped.
--
-- Fix: grant UPDATE on ONLY the `note` column, not the whole row, so this one
-- narrow, compliance-mandated write is possible without reopening logs to
-- general mutation — program_id/effort/completed_at/etc. remain immutable via
-- app_user regardless of role. A new, staff-only, tenant-scoped RLS policy
-- gates WHICH rows, distinct from the existing read-only
-- `workout_log_staff_select` and the member-only `workout_log_member_*`
-- policies (members still cannot update their own or anyone's log).

grant update (note) on workout_log to app_user;

drop policy if exists workout_log_staff_update on workout_log;
create policy workout_log_staff_update on workout_log
  for update
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');
