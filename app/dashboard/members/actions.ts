"use server";

import type { PoolClient } from "pg";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import { validateMemberInput } from "@/lib/members";
import {
  INVITE_TTL_DAYS,
  generateInviteToken,
  inviteAcceptUrl,
} from "@/lib/invites";
import { sendEmail } from "@/lib/email/resend";
import { captureException, reportHandledError } from "@/lib/observability/monitoring";
import { anonymiseMember, exportMemberData } from "@/lib/gdpr/export";
import { generateUniquePinCode } from "@/lib/checkin";

/**
 * Staff-facing member mutations (mvp-member-management-001/003).
 *
 * Every query runs inside `withTenantContext` as the RLS-bound `app_user`, so
 * a member can only ever be created/read/updated within the signed-in staff
 * member's own gym — application code never has to add `where tenant_id = …`.
 */

export type MemberFormState = { error?: string };

/**
 * Resolve the staff row id for the current session. The JWT carries the
 * Supabase auth id (users.auth_user_id), but member_status_event.changed_by
 * targets users(id). Returns null when unmatched — the column is nullable and
 * the event is informational, so a missing author must never block the write.
 */
async function staffUserId(
  c: PoolClient,
  authUserId: string | null | undefined,
): Promise<string | null> {
  if (!authUserId) return null;
  const { rows } = await c.query<{ id: string }>(
    "select id from users where auth_user_id = $1",
    [authUserId],
  );
  return rows[0]?.id ?? null;
}

/** Create a member, then go to its detail page. */
export async function createMemberAction(
  _prev: MemberFormState,
  formData: FormData,
): Promise<MemberFormState> {
  const session = await requireStaff();

  const parsed = validateMemberInput({
    fullName: formData.get("fullName"),
    email: formData.get("email"),
    phone: formData.get("phone"),
    status: formData.get("status"),
    notes: formData.get("notes"),
    photoUrl: formData.get("photoUrl"),
    emergencyContactName: formData.get("emergencyContactName"),
    emergencyContactPhone: formData.get("emergencyContactPhone"),
    membershipStatus: formData.get("membershipStatus"),
  });
  if (!parsed.ok) return { error: parsed.error };
  const {
    fullName,
    email,
    phone,
    status,
    notes,
    photoUrl,
    emergencyContactName,
    emergencyContactPhone,
    membershipStatus,
  } = parsed.value;

  let newId: string;
  try {
    newId = await withTenantContext(session.identity, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into member
           (tenant_id, full_name, email, phone, status, notes, photo_url,
            emergency_contact_name, emergency_contact_phone, membership_status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning id`,
        [
          session.identity.tenantId,
          fullName,
          email,
          phone,
          status,
          notes,
          photoUrl,
          emergencyContactName,
          emergencyContactPhone,
          membershipStatus,
        ],
      );
      const id = rows[0].id;
      // Seed the status history with the initial status (old_status null).
      await c.query(
        `insert into member_status_event
           (tenant_id, member_id, old_status, new_status, changed_by)
         values ($1, $2, null, $3, $4)`,
        [session.identity.tenantId, id, status, await staffUserId(c, session.identity.userId)],
      );
      // Every member gets a check-in PIN from day one (market gap #5) — the
      // qr_token column already defaults itself via gen_random_uuid().
      await generateUniquePinCode(c, session.identity.tenantId, id);
      return id;
    });
  } catch (err) {
    await reportHandledError(err, "create-member", {
      tenantId: session.identity.tenantId,
    });
    return { error: "Could not save the member. Please try again." };
  }

  revalidatePath("/dashboard/members");
  redirect(`/dashboard/members/${newId}`);
}

/** Update an existing member (id carried as a hidden field). */
export async function updateMemberAction(
  _prev: MemberFormState,
  formData: FormData,
): Promise<MemberFormState> {
  const session = await requireStaff();

  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Missing member id." };

  const parsed = validateMemberInput({
    fullName: formData.get("fullName"),
    email: formData.get("email"),
    phone: formData.get("phone"),
    status: formData.get("status"),
    notes: formData.get("notes"),
    photoUrl: formData.get("photoUrl"),
    emergencyContactName: formData.get("emergencyContactName"),
    emergencyContactPhone: formData.get("emergencyContactPhone"),
    membershipStatus: formData.get("membershipStatus"),
  });
  if (!parsed.ok) return { error: parsed.error };
  const {
    fullName,
    email,
    phone,
    status,
    notes,
    photoUrl,
    emergencyContactName,
    emergencyContactPhone,
    membershipStatus,
  } = parsed.value;

  let updated: number;
  try {
    updated = await withTenantContext(session.identity, async (c) => {
      // Read the prior status first so we only log an event when it changes.
      const prev = (
        await c.query<{ status: string }>(
          "select status from member where id = $1",
          [id],
        )
      ).rows[0];
      if (!prev) return 0;

      const res = await c.query(
        `update member
            set full_name = $2, email = $3, phone = $4, status = $5,
                notes = $6, photo_url = $7, emergency_contact_name = $8,
                emergency_contact_phone = $9, membership_status = $10,
                updated_at = now()
          where id = $1`,
        [
          id,
          fullName,
          email,
          phone,
          status,
          notes,
          photoUrl,
          emergencyContactName,
          emergencyContactPhone,
          membershipStatus,
        ],
      );

      if (prev.status !== status) {
        await c.query(
          `insert into member_status_event
             (tenant_id, member_id, old_status, new_status, changed_by)
           values ($1, $2, $3, $4, $5)`,
          [
            session.identity.tenantId,
            id,
            prev.status,
            status,
            await staffUserId(c, session.identity.userId),
          ],
        );
      }
      return res.rowCount ?? 0;
    });
  } catch (err) {
    await reportHandledError(err, "update-member", {
      tenantId: session.identity.tenantId,
      memberId: id,
    });
    return { error: "Could not save changes. Please try again." };
  }

  // RLS makes a cross-tenant id silently match nothing.
  if (updated === 0) return { error: "Member not found." };

  revalidatePath("/dashboard/members");
  revalidatePath(`/dashboard/members/${id}`);
  redirect(`/dashboard/members/${id}`);
}

export type InviteState = {
  error?: string;
  success?: string;
  /**
   * Set when the invite IS valid but its email could not be delivered. Distinct
   * from `error`, which means no usable invite exists.
   */
  warning?: string;
  /**
   * The onboarding link for the invite just issued. Returned so staff can pass
   * it on themselves — the only way to onboard a member on a deployment with no
   * mail provider configured, and a useful escape hatch when a member simply
   * never receives the email.
   */
  acceptUrl?: string;
};

/**
 * Issue an invite for a member: store a single-use, token-bound invite row and
 * email the onboarding link (mvp-member-management-003). Any earlier pending
 * invite for the member is revoked so only the newest link works.
 */
export async function sendInviteAction(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const session = await requireStaff();

  const memberId = String(formData.get("memberId") ?? "");
  if (!memberId) return { error: "Missing member id." };

  // Resolve the member (RLS-scoped) — must have an email to be invited.
  let member: { email: string | null; full_name: string } | null;
  try {
    member = await withTenantContext(session.identity, async (c) => {
      const { rows } = await c.query<{ email: string | null; full_name: string }>(
        "select email, full_name from member where id = $1",
        [memberId],
      );
      return rows[0] ?? null;
    });
  } catch (err) {
    await reportHandledError(err, "send-invite-load-member", {
      tenantId: session.identity.tenantId,
      memberId,
    });
    return { error: "Could not load the member. Please try again." };
  }
  if (!member) return { error: "Member not found." };
  if (!member.email) {
    return { error: "Add an email address to this member before inviting them." };
  }

  const { token, tokenHash } = generateInviteToken();

  let inviteId: string;
  try {
    inviteId = await withTenantContext(session.identity, async (c) => {
      // created_by FK targets users(id) — but the JWT carries the Supabase auth
      // id (users.auth_user_id). Resolve the staff row id; null if unmatched
      // (the column is nullable and informational only).
      const createdBy =
        (
          await c.query<{ id: string }>(
            "select id from users where auth_user_id = $1",
            [session.identity.userId],
          )
        ).rows[0]?.id ?? null;

      // Prior pending invites are superseded below, once this row is known to
      // be the one staff will actually use.
      const { rows } = await c.query<{ id: string }>(
        `insert into invite
           (tenant_id, member_id, email, token_hash, status, expires_at, created_by)
         values ($1, $2, $3, $4, 'pending', now() + ($5 || ' days')::interval, $6)
         returning id`,
        [
          session.identity.tenantId,
          memberId,
          member.email,
          tokenHash,
          String(INVITE_TTL_DAYS),
          createdBy,
        ],
      );
      return rows[0].id;
    });
  } catch (err) {
    await reportHandledError(err, "send-invite-create", {
      tenantId: session.identity.tenantId,
      memberId,
    });
    return { error: "Could not create the invite. Please try again." };
  }

  const acceptUrl = inviteAcceptUrl(token);
  const sent = await sendEmail({
    to: member.email,
    subject: "You're invited to your gym's training portal",
    html: inviteEmailHtml(member.full_name, acceptUrl),
    text: inviteEmailText(member.full_name, acceptUrl),
  });

  // A failed SEND is not a failed INVITE.
  //
  // This used to delete the row and report an error, which made onboarding
  // impossible on any deployment without a mail provider: the invite that had
  // just been granted was destroyed because the notification about it did not
  // go out, so there was no link left for anyone to use and no trace in the
  // invite list. Since the row IS the grant of access — and the token is
  // already in hand — the invite is kept and the link is handed to the staff
  // member instead. Email is one delivery channel for it, not the invite
  // itself.
  //
  // The outcome is recorded either way: 'sent' carries the Resend message id so
  // the inbound webhook can correlate later bounce/complaint events back to
  // this row, and 'failed' carries the reason, which `InviteList` already
  // surfaces as a "Delivery failed" flag against the invite.
  try {
    await withTenantContext(session.identity, async (c) => {
      await c.query(
        `update invite
            set resend_message_id   = $2,
                delivery_status     = $3,
                delivery_detail     = $4,
                delivery_updated_at = now()
          where id = $1`,
        [
          inviteId,
          sent.ok ? sent.id : null,
          sent.ok ? "sent" : "failed",
          sent.ok ? null : sent.error,
        ],
      );
      // Supersede any OTHER still-pending invite so only the newest link works.
      await c.query(
        "update invite set status = 'revoked' where member_id = $1 and status = 'pending' and id <> $2",
        [memberId, inviteId],
      );
    });
  } catch {
    // Best-effort bookkeeping; the invite itself is already usable.
  }

  revalidatePath(`/dashboard/members/${memberId}`);
  revalidatePath("/dashboard/invites");

  if (!sent.ok) {
    // An unconfigured mail provider is an operator-level gap, not an incident:
    // it would otherwise page on every single invite, on a deployment where
    // nothing is broken and the manual-link path works. A provider REJECTION or
    // an unreachable service is the reliability signal worth escalating —
    // invites are how members onboard.
    await captureException(new Error(`Invite email failed: ${sent.error}`), {
      source: "send-invite",
      severity: sent.reason === "not_configured" ? "warning" : "critical",
      reason: sent.reason,
      memberId,
      tenantId: session.identity.tenantId,
    });
    return {
      warning:
        sent.reason === "not_configured"
          ? `The invite for ${member.email} is ready, but this deployment cannot send email. Share the link below with them directly.`
          : `The invite for ${member.email} is ready, but the email could not be sent (${sent.error}). Share the link below with them directly.`,
      acceptUrl,
    };
  }

  return { success: `Invite sent to ${member.email}.`, acceptUrl };
}

/**
 * Revoke a pending invite, invalidating its token immediately
 * (alpha-invite-lifecycle-002). Only a still-`pending` row can be revoked; once
 * revoked the acceptance path rejects the token (a non-pending invite is never
 * `valid`). `memberId` is optional and used only to revalidate the member page.
 */
export async function revokeInviteAction(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const session = await requireStaff();

  const inviteId = String(formData.get("inviteId") ?? "");
  const memberId = String(formData.get("memberId") ?? "");
  if (!inviteId) return { error: "Missing invite id." };

  let updated: number;
  try {
    updated = await withTenantContext(session.identity, async (c) => {
      // WHERE status = 'pending' makes this safe and idempotent: an already
      // accepted/revoked/expired invite matches nothing.
      const res = await c.query(
        "update invite set status = 'revoked' where id = $1 and status = 'pending'",
        [inviteId],
      );
      return res.rowCount ?? 0;
    });
  } catch (err) {
    await reportHandledError(err, "revoke-invite", {
      tenantId: session.identity.tenantId,
      inviteId,
    });
    return { error: "Could not revoke the invite. Please try again." };
  }

  // 0 rows: cross-tenant id (RLS) or the invite was no longer pending.
  if (updated === 0) {
    return { error: "This invite can no longer be revoked." };
  }

  revalidatePath("/dashboard/invites");
  if (memberId) revalidatePath(`/dashboard/members/${memberId}`);
  return { success: "Invite revoked." };
}

/**
 * Issue a fresh check-in PIN for a member (market gap #5) — used for a
 * pre-existing member created before PINs existed, or when a member forgets
 * theirs and asks for a new one.
 */
export async function regeneratePinAction(formData: FormData): Promise<void> {
  const session = await requireStaff();
  const memberId = String(formData.get("memberId") ?? "");
  if (!memberId) return;

  await withTenantContext(session.identity, (c) =>
    generateUniquePinCode(c, session.identity.tenantId, memberId),
  );

  revalidatePath(`/dashboard/members/${memberId}`);
}

// ---------------------------------------------------------------------------
// GDPR data-subject rights (beta-gdpr-001/002). Both actions are staff-gated via
// requireStaff() and run through the RLS-scoped client, so a cross-tenant id is
// invisible — the export/erasure simply finds no subject.

export type ExportActionResult =
  | { ok: true; filename: string; json: string }
  | { ok: false; error: string };

/**
 * Export a member's personal data as a portable JSON document (beta-gdpr-001).
 * The export is logged for audit inside `exportMemberData`. Returns the document
 * as a string for the browser to download — a Server Action cannot stream a file
 * directly, so the client component turns this into a download.
 */
export async function exportMemberAction(
  memberId: string,
): Promise<ExportActionResult> {
  const session = await requireStaff();
  if (!memberId) return { ok: false, error: "Missing member id." };

  let json: string;
  try {
    const { data } = await exportMemberData(session.identity, memberId);
    if (!data) return { ok: false, error: "Member not found." };
    json = JSON.stringify(data, null, 2);
  } catch (err) {
    await reportHandledError(err, "gdpr-export-member", {
      tenantId: session.identity.tenantId,
      memberId,
    });
    return { ok: false, error: "Could not export this member. Please try again." };
  }

  return {
    ok: true,
    filename: `member-${memberId}-export.json`,
    json,
  };
}

export type EraseActionState = { error?: string; success?: string };

/**
 * Erase (anonymise) a member on request (beta-gdpr-002). PII is tombstoned, the
 * row is kept (referential integrity preserved), and the action is logged for
 * audit. Idempotent: erasing an already-erased member reports success.
 */
export async function eraseMemberAction(
  _prev: EraseActionState,
  formData: FormData,
): Promise<EraseActionState> {
  const session = await requireStaff();

  const memberId = String(formData.get("memberId") ?? "");
  if (!memberId) return { error: "Missing member id." };

  let result: Awaited<ReturnType<typeof anonymiseMember>>;
  try {
    result = await anonymiseMember(session.identity, memberId);
  } catch (err) {
    await reportHandledError(err, "gdpr-erase-member", {
      tenantId: session.identity.tenantId,
      memberId,
    });
    return { error: "Could not erase this member. Please try again." };
  }

  if (!result.ok) {
    return { error: "Member not found." };
  }

  revalidatePath("/dashboard/members");
  revalidatePath(`/dashboard/members/${memberId}`);
  revalidatePath("/dashboard/invites");
  return {
    success: result.alreadyErased
      ? "This member was already erased."
      : "Member erased. Their personal data has been anonymised.",
  };
}

function inviteEmailHtml(name: string, url: string): string {
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(url);
  return `<!doctype html>
<html><body style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#0f172a;line-height:1.5">
  <p>Hi ${safeName},</p>
  <p>Your gym has set up a training portal account for you. Click the button below to set your password and view the programs assigned to you.</p>
  <p style="margin:24px 0">
    <a href="${safeUrl}" style="background:#059669;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">Set up your account</a>
  </p>
  <p style="color:#475569;font-size:14px">Or paste this link into your browser:<br><a href="${safeUrl}">${safeUrl}</a></p>
  <p style="color:#94a3b8;font-size:12px">This link expires in ${INVITE_TTL_DAYS} days and can only be used once.</p>
</body></html>`;
}

function inviteEmailText(name: string, url: string): string {
  return [
    `Hi ${name},`,
    "",
    "Your gym has set up a training portal account for you.",
    "Set your password and view your programs here:",
    url,
    "",
    `This link expires in ${INVITE_TTL_DAYS} days and can only be used once.`,
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
