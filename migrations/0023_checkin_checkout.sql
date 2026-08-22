-- 0023_checkin_checkout.sql
--
-- Check-OUT (feedback-2026-08: "what happens when a member leaves? check out
-- logic?"). Until now `check_ins` recorded arrivals only, so the product could
-- answer "how many people came in today" but not "how many are in the building
-- right now" — which is the number a front desk actually wants, and the one the
-- dashboard now shows.
--
-- Modelled as a nullable departure timestamp on the EXISTING row rather than a
-- second 'checkout' event row. A visit is one fact with two times; splitting it
-- would make occupancy a self-join that has to pair rows up and guess what an
-- unpaired one means, and would let a stray checkout exist with no arrival.
--
-- This revises 0016's "no RLS-visible un-checking-in — never an update" note.
-- That note was about not letting anyone REWRITE an arrival; recording a
-- departure is a different operation, and it is still staff-only: the existing
-- `check_ins_staff_all` policy is `for all`, so it already covers this update,
-- and `check_ins_self_select` remains SELECT-only. A member still cannot mark
-- themselves present OR absent — both halves of a visit are witnessed at the
-- desk. No policy change is needed here, and none is made.
alter table check_ins add column if not exists checked_out_at timestamptz;

-- A visit cannot end before it began. Guards against a clock skew or a bad
-- manual fix producing negative-duration visits that would then poison any
-- average-session-length reporting built on this column later.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'check_ins_checkout_after_checkin'
  ) then
    alter table check_ins
      add constraint check_ins_checkout_after_checkin
      check (checked_out_at is null or checked_out_at >= checked_in_at);
  end if;
end
$$;

-- Occupancy reads only ever ask for the OPEN visits ("still in the building"),
-- which are a small minority of the table and shrink to near-zero overnight.
-- A partial index keeps that query off the full per-tenant history, which grows
-- without bound.
create index if not exists idx_check_ins_tenant_open
  on check_ins (tenant_id, checked_in_at desc)
  where checked_out_at is null;
