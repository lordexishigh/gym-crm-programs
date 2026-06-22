-- 0007_invite_delivery_tracking.sql
-- Beta task: email deliverability hardening (beta-hardening-002).
--
-- Tracks the post-send delivery state of an invite email so bounces and spam
-- complaints reported asynchronously by Resend (via the inbound webhook,
-- app/api/email/webhook) can be surfaced to staff in the invite list.
--
-- `resend_message_id` is the id Resend returns on a successful send; the webhook
-- correlates an incoming bounce/complaint event back to the invite row by it.
-- `delivery_status` mirrors the Resend event lifecycle (sent -> delivered, or a
-- terminal bounced / complained / failed). The send path defaults it to 'sent'
-- on a successful API accept; the webhook advances it as events arrive.
--
-- No RLS/grant changes are needed: RLS on `invite` is row-level (the existing
-- invite_staff_all policy already governs these new columns), and the app_user
-- grants in 0002 are table-level. The webhook itself runs via the privileged
-- admin path (no session exists for an inbound provider callback), exactly like
-- invite-token lookup.

alter table invite add column if not exists resend_message_id  text;
alter table invite add column if not exists delivery_status     text
  not null default 'pending'
  check (delivery_status in
    ('pending', 'sent', 'delivered', 'delayed', 'bounced', 'complained', 'failed'));
alter table invite add column if not exists delivery_detail     text;
alter table invite add column if not exists delivery_updated_at timestamptz;

-- The webhook looks invites up by the Resend message id; index it.
create index if not exists idx_invite_resend_message_id
  on invite (resend_message_id);
