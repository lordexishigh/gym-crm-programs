-- 0015_class_scheduling.sql
--
-- Market-gap fix: class/session scheduling with per-class capacity and
-- waitlist auto-promotion — the class calendar gyms live and die by.
--
-- `instructor_name` is denormalized (plain text) rather than requiring a join
-- to `users` for display: members are never granted RLS access to `users`
-- (staff-only table, see 0002), so a member-facing class list needs the name
-- inline. `instructor_id` is kept alongside as an optional FK for staff-side
-- reporting; it is nullable and set null if the staff row is removed.

create table if not exists classes (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references gym(id) on delete cascade,
  name              text not null,
  instructor_id     uuid,
  instructor_name   text,
  starts_at         timestamptz not null,
  duration_minutes  integer not null check (duration_minutes > 0),
  capacity          integer not null check (capacity > 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint classes_instructor_fk
    foreign key (instructor_id, tenant_id) references users (id, tenant_id) on delete set null (instructor_id),
  constraint classes_id_tenant_unique unique (id, tenant_id)
);
create index if not exists idx_classes_tenant on classes (tenant_id);
create index if not exists idx_classes_tenant_starts_at on classes (tenant_id, starts_at);

create table if not exists class_bookings (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references gym(id) on delete cascade,
  class_id      uuid not null,
  member_id     uuid not null,
  status        text not null default 'booked'
                  check (status in ('booked', 'waitlisted', 'cancelled')),
  booked_at     timestamptz not null default now(),
  cancelled_at  timestamptz,
  constraint class_bookings_class_fk
    foreign key (class_id, tenant_id) references classes (id, tenant_id) on delete cascade,
  constraint class_bookings_member_fk
    foreign key (member_id, tenant_id) references member (id, tenant_id) on delete cascade
);
create index if not exists idx_class_bookings_tenant on class_bookings (tenant_id);
create index if not exists idx_class_bookings_class on class_bookings (class_id, status, booked_at);
create index if not exists idx_class_bookings_tenant_member on class_bookings (tenant_id, member_id);
-- A member can hold only ONE active (booked/waitlisted) spot per class —
-- cancelling frees them to book again, which is a new row.
create unique index if not exists idx_class_bookings_one_active_per_member
  on class_bookings (class_id, member_id)
  where status in ('booked', 'waitlisted');

-- ---------------------------------------------------------------------------
-- RLS. classes: staff manage all in the tenant; a member may read the whole
-- schedule (booking requires seeing what's on) but never write a class.
alter table classes        enable row level security;
alter table classes        force  row level security;
alter table class_bookings enable row level security;
alter table class_bookings force  row level security;

drop policy if exists classes_staff_all on classes;
create policy classes_staff_all on classes
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

drop policy if exists classes_member_select on classes;
create policy classes_member_select on classes
  for select
  using (tenant_id = app_current_tenant() and app_current_role() = 'member');

-- class_bookings: staff manage all bookings in the tenant (front-desk
-- cancellations, capacity overrides); a member manages ONLY their own booking
-- (book = insert, cancel = update to 'cancelled') and can never see or touch
-- another member's row.
drop policy if exists class_bookings_staff_all on class_bookings;
create policy class_bookings_staff_all on class_bookings
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

drop policy if exists class_bookings_self_select on class_bookings;
create policy class_bookings_self_select on class_bookings
  for select
  using (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and member_id = app_current_member()
  );

drop policy if exists class_bookings_self_insert on class_bookings;
create policy class_bookings_self_insert on class_bookings
  for insert
  with check (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and member_id = app_current_member()
  );

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
  );

grant select, insert, update, delete on classes, class_bookings to app_user;
