-- 0019_member_photo.sql
--
-- Market-gap fix: a member profile PHOTO staff can actually UPLOAD.
--
-- 0013 added `member.photo_url`, but a URL is not a photo: it only helps a gym
-- that already hosts the image somewhere else. At the front desk the whole
-- point is to attach a face to a record from the phone or laptop in hand, so
-- this migration adds the storage the upload path writes to.
--
-- WHY THE BYTES LIVE IN POSTGRES rather than an object store / storage bucket:
--
--   1. A member photo is personal data under GDPR, and this product's whole
--      isolation story is "RLS, not application code, makes cross-tenant and
--      cross-member access impossible by construction" (docs/ARCHITECTURE.md).
--      A public storage bucket would put every member's face outside that
--      guarantee — readable by anyone holding or guessing the object URL, with
--      no tenant predicate anywhere in the path. Here the photo is an ordinary
--      RLS-scoped row: a cross-tenant read resolves to nothing, and erasure is
--      a DELETE in the same transaction as the rest of the tombstoning.
--   2. It needs no new bucket, credential, or provisioning step, so the feature
--      behaves identically in development, CI and production. A feature that
--      depends on infrastructure nobody has provisioned is a feature that ships
--      "built but not live".
--
-- The size objection is handled at the edges, not here: uploads are downscaled
-- client-side to a 512px avatar and hard-capped server-side at 2 MB (see
-- lib/member-photo.ts), so a stored row is tens of kilobytes.
--
-- A SEPARATE TABLE (not a column on `member`) so the bytea can never be dragged
-- into a roster or detail SELECT by accident, and so the photo carries its own
-- policies and grants.

create table if not exists member_photo (
  member_id     uuid primary key,
  tenant_id     uuid not null references gym(id) on delete cascade,
  content_type  text not null
    check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  bytes         bytea not null,
  byte_size     integer not null check (byte_size > 0),
  updated_at    timestamptz not null default now(),
  -- Tenant-consistent FK (same convention as 0012): a photo can only ever
  -- belong to a member in the same gym, and it dies with that member.
  constraint member_photo_member_fk
    foreign key (member_id, tenant_id) references member (id, tenant_id) on delete cascade
);

create index if not exists idx_member_photo_tenant on member_photo (tenant_id);

-- ---------------------------------------------------------------------------
-- RLS: staff manage photos in their own gym; a member may read only their own.
alter table member_photo enable row level security;
alter table member_photo force  row level security;

drop policy if exists member_photo_staff_all on member_photo;
create policy member_photo_staff_all on member_photo
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

-- The member portal renders the member's own avatar through the same
-- authenticated route, so a member session needs to read exactly one row: its
-- own. Never anyone else's, and never any other gym's.
drop policy if exists member_photo_self_select on member_photo;
create policy member_photo_self_select on member_photo
  for select
  using (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and member_id = app_current_member()
  );

grant select, insert, update, delete on member_photo to app_user;
