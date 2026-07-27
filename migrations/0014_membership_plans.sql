-- 0014_membership_plans.sql
--
-- Market-gap fix: recurring membership plan management (monthly/annual/
-- drop-in tiers with configurable pricing) so a gym can track what each
-- member owes, plus the Stripe correlation columns billing (0015-era webhook
-- handling) needs from day one — added here rather than a follow-up ALTER so
-- member_plans never exists without them.
--
-- membership_plans: the gym's own price list (staff-editable, tenant-scoped).
create table if not exists membership_plans (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references gym(id) on delete cascade,
  name         text not null,
  tier         text not null check (tier in ('monthly', 'annual', 'drop_in')),
  price_cents  integer not null check (price_cents >= 0),
  currency     text not null default 'EUR',
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint membership_plans_id_tenant_unique unique (id, tenant_id)
);
create index if not exists idx_membership_plans_tenant on membership_plans (tenant_id);

-- member_plans: a member's subscription/purchase against one of the gym's
-- plans. `status` tracks the billing lifecycle; `payment_retry_count` and the
-- stripe_* columns are written by the Stripe webhook (checkout completion,
-- invoice.payment_failed / payment_succeeded, subscription cancellation).
create table if not exists member_plans (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references gym(id) on delete cascade,
  member_id                uuid not null,
  plan_id                  uuid not null,
  status                   text not null default 'pending'
                             check (status in ('pending', 'active', 'past_due', 'cancelled')),
  stripe_customer_id       text,
  stripe_subscription_id   text,
  stripe_payment_intent_id text,
  payment_retry_count      integer not null default 0,
  current_period_end       timestamptz,
  started_at               timestamptz not null default now(),
  cancelled_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- Composite uniqueness on (id, tenant_id) — the same shape membership_plans
  -- and member carry. A plain `primary key (id)` is NOT enough to be the target
  -- of a tenant-scoped composite FK: 0017's payment_events.member_plan_fk
  -- references member_plans (id, tenant_id) and Postgres rejects it with
  -- "there is no unique constraint matching given keys" without this. Keeping
  -- tenant_id in the referenced key is what stops a child row in one gym from
  -- pointing at a parent row in another.
  constraint member_plans_id_tenant_unique unique (id, tenant_id),
  constraint member_plans_member_fk
    foreign key (member_id, tenant_id) references member (id, tenant_id) on delete cascade,
  constraint member_plans_plan_fk
    foreign key (plan_id, tenant_id) references membership_plans (id, tenant_id) on delete restrict
);
create index if not exists idx_member_plans_tenant on member_plans (tenant_id);
create index if not exists idx_member_plans_tenant_member on member_plans (tenant_id, member_id);
-- Stripe ids are globally unique — used by the webhook to correlate an event
-- back to a row without a tenant hint (the webhook runs on the admin path).
create unique index if not exists idx_member_plans_stripe_subscription
  on member_plans (stripe_subscription_id) where stripe_subscription_id is not null;

-- ---------------------------------------------------------------------------
-- RLS: staff manage all plans/subscriptions in their tenant; a member may
-- read (never write) their own subscription rows and the gym's active plans
-- (so the portal can show pricing/renewal info without a staff session).
alter table membership_plans enable row level security;
alter table membership_plans force  row level security;
alter table member_plans     enable row level security;
alter table member_plans     force  row level security;

drop policy if exists membership_plans_staff_all on membership_plans;
create policy membership_plans_staff_all on membership_plans
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

drop policy if exists membership_plans_member_select on membership_plans;
create policy membership_plans_member_select on membership_plans
  for select
  using (tenant_id = app_current_tenant() and app_current_role() = 'member' and active);

drop policy if exists member_plans_staff_all on member_plans;
create policy member_plans_staff_all on member_plans
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

drop policy if exists member_plans_self_select on member_plans;
create policy member_plans_self_select on member_plans
  for select
  using (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and member_id = app_current_member()
  );

grant select, insert, update, delete on membership_plans, member_plans to app_user;
