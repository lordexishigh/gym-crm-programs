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
  });
  if (!parsed.ok) return { error: parsed.error };
  const { fullName, email, phone, status, notes } = parsed.value;

  let newId: string;
  try {
    newId = await withTenantContext(session.identity, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into member (tenant_id, full_name, email, phone, status, notes)
         values ($1, $2, $3, $4, $5, $6)
         returning id`,
        [session.identity.tenantId, fullName, email, phone, status, notes],
      );
      const id = rows[0].id;
      // Seed the status history with the initial status (old_status null).
      await c.query(
        `insert into member_status_event
           (tenant_id, member_id, old_status, new_status, changed_by)
         values ($1, $2, null, $3, $4)`,
        [session.identity.tenantId, id, status, await staffUserId(c, session.identity.userId)],
      );
      return id;
    });
  } catch {
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
  });
  if (!parsed.ok) return { error: parsed.error };
  const { fullName, email, phone, status, notes } = parsed.value;

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
                notes = $6, updated_at = now()
          where id = $1`,
        [id, fullName, email, phone, status, notes],
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
  } catch {
    return { error: "Could not save changes. Please try again." };
  }

  // RLS makes a cross-tenant id silently match nothing.
  if (updated === 0) return { error: "Member not found." };

  revalidatePath("/dashboard/members");
  revalidatePath(`/dashboard/members/${id}`);
  redirect(`/dashboard/members/${id}`);
}

export type InviteState = { error?: string; success?: string };

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
  } catch {
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

      // NOTE: prior pending invites are NOT revoked here — only after the email
      // for this new invite actually sends (below). If the send fails we delete
      // this row, and the member keeps whatever valid invite they already had.
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
  } catch {
    return { error: "Could not create the invite. Please try again." };
  }

  const acceptUrl = inviteAcceptUrl(token);
  const sent = await sendEmail({
    to: member.email,
    subject: "You're invited to your gym's training portal",
    html: inviteEmailHtml(member.full_name, acceptUrl),
    text: inviteEmailText(member.full_name, acceptUrl),
  });

  if (!sent.ok) {
    // Roll the invite back so we don't leave a token-bound row that was never
    // delivered; staff can simply try again.
    try {
      await withTenantContext(session.identity, async (c) => {
        await c.query("delete from invite where id = $1", [inviteId]);
      });
    } catch {
      // best-effort cleanup
    }
    return { error: `Invite created but the email failed to send: ${sent.error}` };
  }

  // The new link is delivered — now supersede any OTHER still-pending invite so
  // only the newest link works. Done post-send so a failed send never leaves the
  // member with no valid invite. Best-effort: the new invite is already usable.
  try {
    await withTenantContext(session.identity, async (c) => {
      await c.query(
        "update invite set status = 'revoked' where member_id = $1 and status = 'pending' and id <> $2",
        [memberId, inviteId],
      );
    });
  } catch {
    // best-effort supersede; the delivered invite remains valid regardless
  }

  revalidatePath(`/dashboard/members/${memberId}`);
  revalidatePath("/dashboard/invites");
  return { success: `Invite sent to ${member.email}.` };
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
  } catch {
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

function inviteEmailHtml(name: string, url: string): string {
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(url);
  return `<!doctype html>
<html><body style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#0f172a;line-height:1.5">
  <p>Hi ${safeName},</p>
  <p>Your gym has set up a training portal account for you. Click the button below to set your password and view the programs assigned to you.</p>
  <p style="margin:24px 0">
    <a href="${safeUrl}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">Set up your account</a>
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
