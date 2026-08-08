-- 0013_member_safety_and_status_fields.sql
--
-- Market-gap fix: staff need a photo (fast visual ID at the front desk), an
-- emergency contact (safety incidents), and a membership/renewal status
-- (billing lifecycle) on the member record without leaving the CRM.
--
-- `membership_status` is deliberately separate from the existing `status`
-- column: `status` is the portal/roster active-inactive flag set by staff,
-- while `membership_status` tracks the BILLING lifecycle (kept in sync by the
-- Stripe webhook once a plan is attached — see 0014/0015). Both default to
-- 'active' so existing rows read the same either way after this migration.

alter table member add column if not exists photo_url text;
alter table member add column if not exists emergency_contact_name text;
alter table member add column if not exists emergency_contact_phone text;
alter table member add column if not exists membership_status text
  not null default 'active'
  check (membership_status in ('active', 'expired', 'frozen', 'cancelled'));

create index if not exists idx_member_tenant_membership_status
  on member (tenant_id, membership_status);
