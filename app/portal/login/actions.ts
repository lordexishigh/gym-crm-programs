"use server";

import { redirect } from "next/navigation";
import { signInWithPassword } from "@/lib/auth/supabase";
import { verifyAccessToken, sessionRole, claimValue } from "@/lib/identity";
import { establishSession } from "@/lib/auth/session";
import { guardLoginAttempt, clearLoginThrottle } from "@/lib/auth/login-throttle";
import { reportHandledError } from "@/lib/observability/monitoring";

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

  let role: "staff" | "member";
  let hasMemberId: boolean;
  try {
    const claims = await verifyAccessToken(result.tokens.accessToken);
    role = sessionRole(claims);
    hasMemberId = Boolean(claimValue(claims, "member_id"));
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

  if (role !== "member") {
    return {
      error: "This is a staff account — please use the staff sign-in page.",
    };
  }
  if (!hasMemberId) {
    return {
      error:
        "Your account setup isn't complete yet. Please use your invite link to finish setting up.",
    };
  }

  // Correct credentials: forget the failed attempts so a few typos leave no
  // penalty. Before `redirect`, which throws NEXT_REDIRECT to unwind.
  await clearLoginThrottle("member", email);

  await establishSession(result.tokens);
  redirect("/portal");
}
