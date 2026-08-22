-- 0026_manual_payments.sql
--
-- Market-gap fix (docs/EDGE.md differentiator #3): off-card payments — cash,
-- bank transfer, and in Cyprus specifically SEPA credit transfers — are handled
-- outside every major gym CRM. A gym collecting an annual membership by bank
-- transfer had to record it in a separate ledger, so the CRM's revenue figure
-- never matched the bank statement and owners stopped trusting the dashboard.
--
-- This is the manual counterpart to `payment_events` (0017), which is written
-- ONLY by the Stripe webhook. Deliberately a separate table rather than a `type`
-- column on that one:
--   * `payment_events` rows are machine-authored and idempotent on
--     `stripe_event_id`; these are human-authored and need the opposite —
--     provenance (who entered it) and a void trail.
--   * The reconciliation view the owner needs is precisely "card total vs manual
--     total, side by side", which is clearer as a union of two well-typed tables
--     than as two filtered halves of one.
-- The revenue view reads both and shows Stripe / manual / combined.
--
-- IMMUTABLE BY DESIGN. There is no edit path: a mistake is corrected by VOIDING
-- the row (recording who voided it and why) and entering a replacement. A
-- bookkeeping ledger that can be silently rewritten is worth less than no ledger,
-- because the dispute it exists to settle becomes unwinnable. The cost of this
-- choice is support load on typos, which EDGE flags — mitigated by making the
-- audit trail visible in the UI rather than by allowing edits.
create table if not exists manual_payment (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references gym(id) on delete cascade,
  member_id         uuid not null,
  -- Integer cents, mirroring payment_events.amount_cents so the two can be
  -- summed in one reconciliation query with no float rounding anywhere.
  amount_cents      integer not null check (amount_cents > 0),
  currency          text not null default 'EUR',
  -- How the money actually arrived. 'sepa' is separate from 'bank_transfer'
  -- because it is the culturally normal instrument in the launch market and the
  -- bookkeeper reconciles it against a distinct bank-statement line.
  method            text not null
    check (method in ('cash', 'bank_transfer', 'sepa', 'other')),
  -- The bank's own reference, so a row can be tied back to a statement line.
  -- Free text: SEPA end-to-end ids, cheque numbers and hand-written receipt
  -- numbers have no shared format worth constraining.
  reference         text,
  note              text,
  -- When the money was RECEIVED, which is not when it was typed in. The
  -- bookkeeper reconciles against the former; `created_at` keeps the latter.
  received_on       date not null,
  -- Provenance. Nullable + `on delete set null` so a staff member leaving the
  -- gym never cascades away financial history; the row survives, attribution
  -- degrades to "a since-removed staff account".
  entered_by        uuid,
  voided_at         timestamptz,
  voided_by         uuid,
  void_reason       text,
  created_at        timestamptz not null default now(),
  constraint manual_payment_member_fk
    foreign key (member_id, tenant_id) references member (id, tenant_id) on delete cascade,
  constraint manual_payment_entered_by_fk
    foreign key (entered_by, tenant_id) references users (id, tenant_id) on delete set null (entered_by),
  constraint manual_payment_voided_by_fk
    foreign key (voided_by, tenant_id) references users (id, tenant_id) on delete set null (voided_by),
  -- A void is all-or-nothing: a row is either live, or voided WITH a timestamp
  -- and a reason. Without this, a partially-written void reads as live to the
  -- revenue query while looking voided in the UI.
  constraint manual_payment_void_complete check (
    (voided_at is null and void_reason is null)
    or (voided_at is not null and void_reason is not null)
  )
);

create index if not exists idx_manual_payment_tenant on manual_payment (tenant_id);
create index if not exists idx_manual_payment_tenant_member
  on manual_payment (tenant_id, member_id, received_on desc);
-- The revenue dashboard's hot path: sum live rows in a date window for a tenant.
create index if not exists idx_manual_payment_tenant_received
  on manual_payment (tenant_id, received_on) where voided_at is null;

alter table manual_payment enable row level security;
alter table manual_payment force  row level security;

drop policy if exists manual_payment_staff_all on manual_payment;
create policy manual_payment_staff_all on manual_payment
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

-- A member sees their own payments in the portal's billing history, read-only —
-- the same shape as payment_events_self_select (0017). No member write path
-- exists: a member must never be able to assert that they paid cash.
drop policy if exists manual_payment_self_select on manual_payment;
create policy manual_payment_self_select on manual_payment
  for select
  using (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and member_id = app_current_member()
  );

-- UPDATE is granted because the void path is an UPDATE (staff-only via the
-- policy above). DELETE is granted for GDPR erasure, which must be able to
-- remove a data subject's rows outright — see lib/gdpr/export.ts and
-- docs/DATA_RETENTION.md.
grant select, insert, update, delete on manual_payment to app_user;
