-- 0017_payment_events.sql
--
-- Market-gap fix: the member portal needs real PAYMENT HISTORY, not just a
-- current subscription status — this is a per-charge log written by the
-- Stripe webhook (lib/stripe-events.ts) on every succeeded/failed payment
-- event, so the portal (and staff) can see exactly what was charged and when.
--
-- `stripe_event_id` gives idempotency: Stripe delivers webhooks at-least-once
-- and may redeliver the same event, so the unique index (where not null)
-- prevents a retried delivery from duplicating a payment-history row.
create table if not exists payment_events (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references gym(id) on delete cascade,
  member_id       uuid not null,
  member_plan_id  uuid,
  amount_cents    integer not null,
  currency        text not null,
  status          text not null check (status in ('succeeded', 'failed')),
  stripe_event_id text,
  occurred_at     timestamptz not null default now(),
  constraint payment_events_member_fk
    foreign key (member_id, tenant_id) references member (id, tenant_id) on delete cascade,
  constraint payment_events_member_plan_fk
    foreign key (member_plan_id, tenant_id) references member_plans (id, tenant_id) on delete set null (member_plan_id)
);
create index if not exists idx_payment_events_tenant on payment_events (tenant_id);
create index if not exists idx_payment_events_tenant_member
  on payment_events (tenant_id, member_id, occurred_at desc);
create unique index if not exists idx_payment_events_stripe_event
  on payment_events (stripe_event_id) where stripe_event_id is not null;

alter table payment_events enable row level security;
alter table payment_events force  row level security;

drop policy if exists payment_events_staff_all on payment_events;
create policy payment_events_staff_all on payment_events
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

drop policy if exists payment_events_self_select on payment_events;
create policy payment_events_self_select on payment_events
  for select
  using (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and member_id = app_current_member()
  );

grant select, insert, update, delete on payment_events to app_user;
