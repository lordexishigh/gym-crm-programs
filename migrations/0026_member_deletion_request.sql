-- 0026_member_deletion_request.sql
-- Member-initiated right-to-erasure requests (beta-gdpr-002 — "Member PII
-- erasure workflow").
--
-- Migration 0004 gave the CONTROLLER an erasure button (member.erased_at +
-- gdpr_audit_event). What it never gave the DATA SUBJECT was a way to ask: an
-- Art. 17 request had to arrive out of band (email, phone, at the desk), so
-- there was nothing in the product for the gym to see, decide on, or evidence.
--
-- This table is that missing hop: the member files a request from their portal,
-- it appears as pending work in the gym's dashboard, and the staff decision
-- (confirm -> anonymise, or decline with a reason) is recorded against it. The
-- row deliberately OUTLIVES the erasure it triggers — it is the controller's
-- evidence that a request was received and answered inside the statutory
-- window, so it must survive the personal data it concerned.
--
-- It holds no copy of the member's contact details. The confirmation email
-- address is read from the member row inside the confirm flow, moments before
-- that row is tombstoned, so this table never becomes a second store of the
-- very PII the request exists to remove; `confirmation_email` records only
-- whether the send landed. `reason` is the member's own words and IS personal
-- data, so `anonymiseMember` scrubs it as part of the erasure (see
-- lib/gdpr/export.ts), leaving the request/decision skeleton behind.
--
-- Idempotent: safe to run against a fresh or an existing database. Follows the
-- tenant-consistency + RLS conventions of 0001/0002/0004/0025.

create table if not exists member_deletion_request (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references gym(id) on delete cascade,
  member_id          uuid not null,
  -- pending  -> awaiting a staff decision (the dashboard's work queue)
  -- completed-> confirmed; the member row has been anonymised
  -- declined -> refused (e.g. a legal retention obligation), with a reason
  status             text not null default 'pending'
                       check (status in ('pending', 'completed', 'declined')),
  -- The member's own words. Optional, and scrubbed on erasure.
  reason             text,
  requested_at       timestamptz not null default now(),
  decided_at         timestamptz,
  decided_by         uuid,
  decision_note      text,
  -- Whether the subject was told: 'sent' | 'failed' (provider rejected /
  -- unconfigured) | 'skipped' (no address on file). Null while pending.
  confirmation_email text
                       check (confirmation_email is null
                              or confirmation_email in ('sent', 'failed', 'skipped')),
  -- Tenant-consistent FKs: a request's member/decider must be in the same gym.
  -- The member FK is ON DELETE CASCADE like member_task's — erasure ANONYMISES
  -- rather than deletes the member row, so in practice the request survives.
  constraint member_deletion_request_member_fk
    foreign key (member_id, tenant_id) references member (id, tenant_id) on delete cascade,
  constraint member_deletion_request_decider_fk
    foreign key (decided_by, tenant_id) references users (id, tenant_id) on delete set null (decided_by)
);

create index if not exists idx_member_deletion_request_tenant
  on member_deletion_request (tenant_id, status, requested_at desc);
create index if not exists idx_member_deletion_request_member
  on member_deletion_request (tenant_id, member_id, requested_at desc);

-- One live request per member: a double tap on the portal button, or an
-- impatient member asking again next week, must not fan out into two rows the
-- gym has to decide on separately. Enforced in the database rather than by a
-- read-then-insert, which would race.
create unique index if not exists uq_member_deletion_request_pending
  on member_deletion_request (member_id) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Row Level Security. A new tenanted table must enable + force RLS itself (the
-- auto-discovery audit in test/isolation-coverage.test.ts fails CI otherwise).
alter table member_deletion_request enable row level security;
alter table member_deletion_request force  row level security;

-- Staff read every request in their own gym and record the decision.
drop policy if exists member_deletion_request_staff_all on member_deletion_request;
create policy member_deletion_request_staff_all on member_deletion_request
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

-- A member may FILE a request, for themselves only, and only as `pending` with
-- no decision pre-filled — the decision is the controller's to make. This is
-- the same shape as gdpr_audit_event's member self-insert policy (0004/0006).
drop policy if exists member_deletion_request_member_insert on member_deletion_request;
create policy member_deletion_request_member_insert on member_deletion_request
  for insert
  with check (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and member_id = app_current_member()
    and status = 'pending'
    and decided_at is null
    and decided_by is null
    and decision_note is null
    and confirmation_email is null
  );

-- A member may READ their own requests, so the portal can show them where the
-- request stands. Note there is deliberately NO member UPDATE/DELETE policy:
-- once filed, a request is the controller's record, not the member's to edit.
drop policy if exists member_deletion_request_member_select on member_deletion_request;
create policy member_deletion_request_member_select on member_deletion_request
  for select
  using (
    tenant_id = app_current_tenant()
    and app_current_role() = 'member'
    and member_id = app_current_member()
  );

grant select, insert, update, delete on member_deletion_request to app_user;
