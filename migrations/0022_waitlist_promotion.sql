-- 0022_waitlist_promotion.sql
--
-- Renumbered twice: first from 0019_waitlist_promotion.sql (shared the
-- `0019` prefix with 0019_member_photo.sql), then from
-- 0020_waitlist_promotion.sql (collided with 0020_task_queue.sql, added
-- independently on master). See scripts/migrate.mjs's RENAMED map for the
-- backfill that keeps an already-migrated database (which recorded an older
-- filename) from re-running this file's DDL under the new name.
--
-- Market-gap fix: waitlist auto-promotion needs to be OBSERVABLE, not just
-- performed.
--
-- 0015 shipped the schedule, the capacity limit and the waitlist, and
-- `cancelBooking` (lib/classes.ts) already flipped the longest-waiting
-- waitlisted row to 'booked' when a confirmed spot was freed. But the
-- promotion left no trace: the row became indistinguishable from one that was
-- booked normally. Three consequences, all of which this migration fixes:
--
--   1. The promoted member was never told. The waitlist confirmation email
--      (lib/notifications.ts) literally promises "we'll email you if a spot
--      opens up" — a promise nothing in the codebase kept. Sending that email
--      needs a record of WHICH bookings were just promoted.
--   2. Re-sending was unguarded. Without a notified marker, any retry of the
--      promotion path could email the same member repeatedly.
--   3. Staff had no audit trail — the class roster could not show that a spot
--      was filled from the waitlist rather than booked at the front desk.
--
-- Both columns are nullable with no default, so every existing row reads as
-- "not promoted", which is the correct history: nothing was ever promoted with
-- a record before now.
--
-- No new GRANT is required. 0015 issued a TABLE-level
-- `grant select, insert, update, delete on class_bookings to app_user`, and a
-- table-level grant covers columns added later (unlike the column-level grant
-- in 0018). The existing staff/self UPDATE policies likewise apply row-wise and
-- need no change.

alter table class_bookings
  add column if not exists promoted_at timestamptz;

alter table class_bookings
  add column if not exists promotion_notified_at timestamptz;

comment on column class_bookings.promoted_at is
  'When this booking was auto-promoted from waitlisted to booked because a confirmed spot was freed. Null for a booking that was never on the waitlist.';
comment on column class_bookings.promotion_notified_at is
  'When the promoted member was successfully emailed about their new spot. Null means not yet notified; guards against double-sending.';

-- Promotion picks the longest-waiting waitlisted row for a class, and the
-- notify sweep looks for promoted-but-not-yet-notified rows. The existing
-- idx_class_bookings_class (class_id, status, booked_at) already serves the
-- first. This partial index serves the second and stays tiny — it holds only
-- the rows currently awaiting an email, which is normally zero.
create index if not exists idx_class_bookings_promotion_unnotified
  on class_bookings (tenant_id, promoted_at)
  where promoted_at is not null and promotion_notified_at is null;
