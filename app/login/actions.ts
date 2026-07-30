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

  const result = await signInWithPassword(email, password);
  if (!result.ok) {
    return { error: result.error };
  }

  // Re-verify the token rather than trusting the auth response body, and gate
  // by audience: staff sign in here, members use the portal.
  let claims: AccessTokenClaims;
  try {
    claims = await verifyAccessToken(result.tokens.accessToken);
  } catch {
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

  await establishSession(result.tokens);
  redirect(STAFF_LANDING);
}
