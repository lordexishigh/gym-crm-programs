"use server";

import { redirect } from "next/navigation";
import { signInWithPassword } from "@/lib/auth/supabase";
import {
  identityFromClaims,
  verifyAccessToken,
  sessionRole,
  type AccessTokenClaims,
} from "@/lib/identity";
import { establishSession } from "@/lib/auth/session";
import { guardLoginAttempt, clearLoginThrottle } from "@/lib/auth/login-throttle";
import { reportHandledError } from "@/lib/observability/monitoring";
import {
  ACCOUNT_NOT_LINKED_TO_GYM,
  STAFF_LANDING,
} from "@/lib/auth/sign-in-reason";

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
 *
 * The last gate before a session is stored is a dry run of the DESTINATION's own
 * identity check, so a sign-in either lands on a working page or explains on the
 * form why it cannot — see the note above `identityFromClaims` below.
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
  let claims: AccessTokenClaims;
  try {
    claims = await verifyAccessToken(result.tokens.accessToken);
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

  if (sessionRole(claims) !== "staff") {
    return {
      error: "This account is a member account — use the member portal to sign in.",
    };
  }

  /*
   * Confirm the destination will actually accept this session BEFORE committing
   * to it. `/dashboard` resolves its identity through `identityFromClaims`,
   * which THROWS when the token carries no `tenant_id` — and `getSession`
   * converts that throw into "no session", so `requireStaff` would bounce
   * straight back to this form.
   *
   * That produced the dead end the review found: sign-in reports success, the
   * cookies are set, the browser navigates to /dashboard, and the user lands
   * back on an empty login form with no error. Entering the same (valid)
   * credentials again reproduces it exactly — an unbreakable
   * login → dashboard → login loop that reads as "login is broken".
   *
   * Checking the same mapping the guard checks, here, means sign-in either
   * lands on a working page or explains on the form why it cannot. It must run
   * BEFORE `establishSession` so a session that cannot be used is never stored.
   */
  try {
    identityFromClaims(claims);
  } catch {
    return { error: ACCOUNT_NOT_LINKED_TO_GYM };
  }

  // Correct credentials AND a usable destination: forget the failed attempts so
  // a few typos leave no penalty. Deliberately after every rejection above — a
  // submission that cannot produce a working session is not a successful
  // sign-in, and must not hand back a fresh guessing budget. Before `redirect`,
  // which throws NEXT_REDIRECT to unwind.
  await clearLoginThrottle("staff", email);

  await establishSession(result.tokens);
  redirect(STAFF_LANDING);
}
