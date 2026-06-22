"use server";

import { redirect } from "next/navigation";
import { withAdminContext } from "@/lib/db";
import { lookupInviteByToken } from "@/lib/invite-acceptance";
import { createMemberAuthUser, deleteAuthUser } from "@/lib/auth/admin";
import { signInWithPassword } from "@/lib/auth/supabase";
import { verifyAccessToken, sessionRole, claimValue } from "@/lib/identity";
import { establishSession } from "@/lib/auth/session";
import { reportHandledError } from "@/lib/observability/monitoring";

/**
 * Invite acceptance: provision the member's portal account (mvp-member-management-004).
 *
 * Flow (all token-gated, no pre-existing session):
 *   1. Re-validate the token authoritatively (the page validated it for render,
 *      but state may have changed).
 *   2. Create a confirmed Supabase Auth user carrying the member's claims in
 *      app_metadata (tenant_id / app_role=member / member_id).
 *   3. Link the auth user to the Member row and mark the invite accepted
 *      (single-use) — via the admin path since no member session exists yet.
 *   4. Sign the member in and send them to the portal.
 */
export type AcceptState = { error?: string };

const MIN_PASSWORD = 8;

export async function acceptInviteAction(
  _prev: AcceptState,
  formData: FormData,
): Promise<AcceptState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password.length < MIN_PASSWORD) {
    return { error: `Password must be at least ${MIN_PASSWORD} characters.` };
  }
  if (password !== confirm) {
    return { error: "Passwords do not match." };
  }

  const invite = await lookupInviteByToken(token);
  if (invite.status === "expired") {
    return { error: "This invite has expired. Ask your gym for a new one." };
  }
  if (invite.status === "used") {
    return { error: "This invite has already been used. Try signing in." };
  }
  if (invite.status !== "valid") {
    return { error: "This invite link is invalid." };
  }

  // 2. Create the auth user with member claims baked into app_metadata.
  const created = await createMemberAuthUser({
    email: invite.email,
    password,
    claims: { tenant_id: invite.tenantId, member_id: invite.memberId },
  });
  if (!created.ok) {
    return { error: created.error };
  }

  // 3. Link the auth user to the Member row and consume the invite atomically.
  //    Both UPDATEs share one transaction. The conditional invite UPDATE enforces
  //    single-use under a race (only a still-pending row flips to accepted); if
  //    the member link then matches no row we throw to roll the whole transaction
  //    back, so an invite is never left 'accepted' without a bound auth user.
  let consumed: "ok" | "used";
  try {
    consumed = await withAdminContext(async (c) => {
      const inviteRes = await c.query(
        `update invite
            set status = 'accepted', accepted_at = now()
          where id = $1 and status = 'pending'`,
        [invite.inviteId],
      );
      if ((inviteRes.rowCount ?? 0) === 0) return "used";

      const memberRes = await c.query(
        `update member
            set auth_user_id = $2,
                email = coalesce(email, $3),
                updated_at = now()
          where id = $1 and tenant_id = $4`,
        [invite.memberId, created.user.id, invite.email, invite.tenantId],
      );
      // The member row was deleted/moved out from under us. Throw so the invite
      // flip above rolls back rather than leaving an accepted-but-unlinked invite.
      if ((memberRes.rowCount ?? 0) === 0) {
        throw new Error("member-link-failed");
      }
      return "ok";
    });
  } catch (err) {
    // The auth user exists but the member link/invite-consume transaction failed.
    // This is a reliability problem in the onboarding flow worth alerting on —
    // the invitee is left in a half-provisioned state.
    await reportHandledError(err, "invite-accept-link", {
      severity: "critical",
      tenantId: invite.tenantId,
      memberId: invite.memberId,
      inviteId: invite.inviteId,
    });
    return {
      error: "Your account was created but linking failed. Please try signing in.",
    };
  }

  if (consumed === "used") {
    // A concurrent acceptance won the race, so the invite UPDATE matched no row
    // and the member link was skipped. Delete the auth user we just created so
    // it isn't left orphaned (the winning acceptance bound its own user).
    await deleteAuthUser(created.user.id);
    return { error: "This invite has already been used. Try signing in." };
  }

  // 4. Establish a session so the member lands in the portal already signed in.
  //    If anything here is off, fall back to the portal login (the account is
  //    created and linked, so they can sign in manually).
  const signIn = await signInWithPassword(invite.email, password);
  let sessionOk = false;
  if (signIn.ok) {
    try {
      const claims = await verifyAccessToken(signIn.tokens.accessToken);
      sessionOk =
        sessionRole(claims) === "member" && Boolean(claimValue(claims, "member_id"));
    } catch {
      sessionOk = false;
    }
  }

  // redirect() throws NEXT_REDIRECT — keep it OUT of any try/catch above.
  if (signIn.ok && sessionOk) {
    await establishSession(signIn.tokens);
    redirect("/portal");
  }
  redirect("/portal/login");
}
