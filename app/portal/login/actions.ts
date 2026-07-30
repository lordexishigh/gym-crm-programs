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
import { guardLoginAttempt, clearLoginThrottle } from "@/lib/auth/login-throttle";
import { reportHandledError } from "@/lib/observability/monitoring";
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
 *
 * Rate limited per IP and per account before any auth call (beta-hardening-002).
 * The `member` scope keeps its buckets separate from staff sign-in: the portal is
 * the public-facing surface with the larger account population, and a spray
 * against it must not throttle the gym's own staff out of the dashboard.
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

  // Throttle FIRST: a refused attempt must not cost a GoTrue round-trip, and
  // must not be able to guess a password on the way to being refused.
  const throttled = await guardLoginAttempt("member", email);
  if (throttled) return throttled;

  const result = await signInWithPassword(email, password);
  if (!result.ok) {
    if (result.kind === "unavailable") {
      // Not a wrong password — no member can sign in at all right now.
      await reportHandledError(new Error(result.error), "member-login", {
        reason: "auth-service-unavailable",
      });
    }
    return { error: result.error };
  }

  let claims: AccessTokenClaims;
  try {
    claims = await verifyAccessToken(result.tokens.accessToken);
  } catch (err) {
    // A token this deployment cannot verify (unreachable JWKS, keys from another
    // project) fails every portal login even with the right password. Reported
    // as critical: without this the exception died here and the member was told
    // to "try again" indefinitely.
    await reportHandledError(err, "member-login", {
      reason: "access-token-verification-failed",
      severity: "critical",
    });
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

  // Correct credentials AND a usable destination: forget the failed attempts so
  // a few typos leave no penalty. Deliberately after every rejection above — a
  // submission that cannot produce a working session is not a successful
  // sign-in, and must not hand back a fresh guessing budget. Before `redirect`,
  // which throws NEXT_REDIRECT to unwind.
  await clearLoginThrottle("member", email);

  await establishSession(result.tokens);
  redirect(MEMBER_LANDING);
}
