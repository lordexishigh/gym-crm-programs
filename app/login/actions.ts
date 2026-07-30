"use server";

import { redirect } from "next/navigation";
import { signInWithPassword } from "@/lib/auth/supabase";
import { verifyAccessToken, sessionRole } from "@/lib/identity";
import { establishSession } from "@/lib/auth/session";
import { guardLoginAttempt, clearLoginThrottle } from "@/lib/auth/login-throttle";
import { reportHandledError } from "@/lib/observability/monitoring";

/**
 * Staff sign-in (mvp-auth-002).
 *
 * Authenticates against Supabase Auth, verifies the returned access token
 * server-side, confirms the session is a STAFF audience, then establishes the
 * session cookies and routes to the dashboard. tenant_id is derived from the
 * verified token only — never from the form.
 *
 * Rate limited per IP and per account before any auth call (beta-hardening-002),
 * and every failure that is NOT "wrong password" is reported to monitoring —
 * see the two call sites below for why each matters.
 */
export type LoginState = { error?: string };

export async function loginAction(
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
  const throttled = await guardLoginAttempt("staff", email);
  if (throttled) return throttled;

  const result = await signInWithPassword(email, password);
  if (!result.ok) {
    if (result.kind === "unavailable") {
      // NOT a wrong password — the auth service is unusable, so *every* staff
      // sign-in is failing right now. Previously this returned a friendly string
      // and told nobody, so a broken deployment looked identical to a busy one.
      await reportHandledError(new Error(result.error), "staff-login", {
        reason: "auth-service-unavailable",
      });
    }
    return { error: result.error };
  }

  // Re-verify the token rather than trusting the auth response body, and gate
  // by audience: staff sign in here, members use the portal.
  let role: "staff" | "member";
  try {
    const claims = await verifyAccessToken(result.tokens.accessToken);
    role = sessionRole(claims);
  } catch (err) {
    // The auth service issued a token this deployment cannot verify: a JWKS it
    // cannot fetch, or keys from a different Supabase project. That is a 100%
    // login failure with a correct password, and it was the single most
    // invisible failure in the app — the exception died in this `catch` and the
    // visitor was told to "try again", forever.
    await reportHandledError(err, "staff-login", {
      reason: "access-token-verification-failed",
      severity: "critical",
    });
    return { error: "Sign-in failed. Please try again." };
  }

  if (role !== "staff") {
    return {
      error: "This account is a member account — use the member portal to sign in.",
    };
  }

  // Correct credentials: forget the failed attempts so a few typos leave no
  // penalty. Before `redirect`, which throws NEXT_REDIRECT to unwind.
  await clearLoginThrottle("staff", email);

  await establishSession(result.tokens);
  redirect("/dashboard");
}
