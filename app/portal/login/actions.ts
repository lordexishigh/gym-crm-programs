"use server";

import { redirect } from "next/navigation";
import { signInWithPassword } from "@/lib/auth/supabase";
import {
  identityFromClaims,
  verifyAccessToken,
  sessionRole,
  type AccessTokenClaims,
} from "@/lib/identity";
import type { Identity } from "@/lib/db";
import { establishSession } from "@/lib/auth/session";
import {
  ACCOUNT_NOT_LINKED_TO_GYM,
  MEMBER_LANDING,
} from "@/lib/auth/sign-in-reason";

/**
 * Member portal sign-in (mvp-auth-003).
 *
 * For invited members who have completed account setup. Authenticates against
 * Supabase Auth, verifies the access token server-side, and requires a MEMBER
 * audience carrying a member_id so the session resolves to a Member row under
 * RLS. tenant_id/member_id come from the verified token only.
 */
export type LoginState = { error?: string };

export async function memberLoginAction(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  const result = await signInWithPassword(email, password);
  if (!result.ok) {
    return { error: result.error };
  }

  let claims: AccessTokenClaims;
  try {
    claims = await verifyAccessToken(result.tokens.accessToken);
  } catch {
    return { error: "Sign-in failed. Please try again." };
  }

  if (sessionRole(claims) !== "member") {
    return {
      error: "This is a staff account — please use the staff sign-in page.",
    };
  }

  /*
   * Confirm `/portal` will accept this session BEFORE committing to it — see
   * the longer note in app/login/actions.ts for the loop this prevents. The
   * member side has two ways to fail the destination guard, and `requireMember`
   * reads BOTH off the resolved identity, so we resolve the identity here and
   * check the same two fields rather than re-deriving them from the raw claims:
   *
   *   - no `tenant_id` → `identityFromClaims` throws → `getSession` reports "no
   *     session" → bounced back to this form.
   *   - no `member_id` → `requireMember`'s own `!memberId` check → same bounce.
   *
   * Reading `identity.memberId` (rather than `claimValue(claims, "member_id")`)
   * is deliberate: it is the exact value the guard gates on, so the two can't
   * drift apart and reopen the loop.
   */
  let identity: Identity;
  try {
    identity = identityFromClaims(claims);
  } catch {
    return { error: ACCOUNT_NOT_LINKED_TO_GYM };
  }

  if (!identity.memberId) {
    return {
      error:
        "Your account setup isn't complete yet. Please use your invite link to finish setting up.",
    };
  }

  await establishSession(result.tokens);
  redirect(MEMBER_LANDING);
}
