-- 0024_class_bookings_self_update_cancel_only.sql
--
-- (Renumbered from 0020 on 2026-08-13: this branch was authored before
-- 0020_task_queue.sql landed and shared its prefix, which
-- test/migration-filenames.test.ts rejects because migrate.mjs applies files in
-- filename order. Safe to renumber rather than alias — unlike the 0011/0012
-- case, this file has never been applied anywhere, so no schema_migrations row
-- refers to the old name and there is no DDL to re-run.)
--
-- Security fix: class_bookings_self_update (0015) let a member move their OWN
-- booking to ANY status, not just 'cancelled'.
--
-- 0015's own comment documents the intended capability as cancel-only ("a
-- member manages ONLY their own booking (book = insert, cancel = update to
-- 'cancelled')"), but the policy's WITH CHECK only constrained tenant_id /
-- role / member_id — it never constrained status. That let a member session
-- issue `update class_bookings set status = 'booked' where id = <own row>`
-- to:
--   1. self-promote a waitlisted booking to 'booked', bypassing the capacity
--      check in `promoteFromWaitlist` (lib/classes.ts) entirely, and
--   2. resurrect their own 'cancelled' booking back to 'booked' or
--      'waitlisted', bypassing the one-active-booking-per-class uniqueness
--      the app relies on to keep counts correct.
--
-- No current UI/Server Action path issues that UPDATE (`cancelBooking` in
-- lib/classes.ts always sets status = 'cancelled'), so this closes a
-- defense-in-depth gap in the DB-layer guarantee the app advertises, not a
-- live exploit through the product today.
drop policy if exists class_bookings_self_update on class_bookings;
create policy class_bookings_self_update on class_bookings
  for update
  using (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and member_id = app_current_member()
  )
  with check (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and member_id = app_current_member()
    and status = 'cancelled'
  );
