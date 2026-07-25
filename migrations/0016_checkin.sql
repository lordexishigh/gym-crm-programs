-- 0016_checkin.sql
--
-- Market-gap fix: QR/PIN check-in so staff can record attendance in under 3
-- seconds at the front desk.
--
-- `qr_token` is globally unique (128-bit, DB-generated) so a member's
-- personal QR code can be looked up directly without knowing which tenant it
-- belongs to. `pin_code` is a short, human-typeable 6-digit code — only
-- unique WITHIN a tenant (enforced by the partial unique index below), so a
-- front-desk staff session (which already has a tenant context) can look a
-- member up by PIN alone; it starts null and is assigned on demand (see
-- lib/checkin.ts) rather than backfilled here, since generating a
-- tenant-unique code needs a retry-on-conflict loop the application already
-- has for invite tokens.
alter table member add column if not exists pin_code text;
alter table member add column if not exists qr_token uuid not null default gen_random_uuid();

create unique index if not exists idx_member_qr_token on member (qr_token);
create unique index if not exists idx_member_tenant_pin_code
  on member (tenant_id, pin_code) where pin_code is not null;

-- check_ins: append-only attendance log. No RLS-visible "un-checking-in" —
-- an erroneous check-in is a staff-only delete, never an update.
create table if not exists check_ins (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references gym(id) on delete cascade,
  member_id    uuid not null,
  method       text not null check (method in ('pin', 'qr')),
  checked_in_at timestamptz not null default now(),
  constraint check_ins_member_fk
    foreign key (member_id, tenant_id) references member (id, tenant_id) on delete cascade
);
create index if not exists idx_check_ins_tenant on check_ins (tenant_id);
create index if not exists idx_check_ins_tenant_member on check_ins (tenant_id, member_id, checked_in_at desc);
create index if not exists idx_check_ins_tenant_checked_in_at on check_ins (tenant_id, checked_in_at desc);

alter table check_ins enable row level security;
alter table check_ins force  row level security;

-- Staff-only: check-in is recorded by the front-desk kiosk (a staff session);
-- a member never writes their own attendance row (that would let them
-- self-report attendance without actually presenting a PIN/QR to staff). A
-- member MAY read their own history (shown on the portal).
drop policy if exists check_ins_staff_all on check_ins;
create policy check_ins_staff_all on check_ins
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

drop policy if exists check_ins_self_select on check_ins;
create policy check_ins_self_select on check_ins
  for select
  using (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and member_id = app_current_member()
  );

grant select, insert, update, delete on check_ins to app_user;
