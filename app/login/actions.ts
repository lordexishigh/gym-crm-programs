"use server";

import { redirect } from "next/navigation";
import { signInWithPassword } from "@/lib/auth/supabase";
import { verifyAccessToken, sessionRole } from "@/lib/identity";
import { establishSession } from "@/lib/auth/session";
import { guardLoginAttempt, clearLoginThrottle } from "@/lib/auth/login-throttle";

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

  // Throttled before touching the auth service: a blocked attempt costs no
  // GoTrue round-trip and cannot be used to probe account existence.
  const throttled = await guardLoginAttempt("staff", email);
  if (throttled) return throttled;

  const result = await signInWithPassword(email, password);
  if (!result.ok) {
    return { error: result.error };
  }

  // Re-verify the token rather than trusting the auth response body, and gate
  // by audience: staff sign in here, members use the portal.
  let role: "staff" | "member";
  try {
    const claims = await verifyAccessToken(result.tokens.accessToken);
    role = sessionRole(claims);
  } catch {
    return { error: "Sign-in failed. Please try again." };
  }

  if (role !== "staff") {
    return {
      error: "This account is a member account — use the member portal to sign in.",
    };
  }

  await clearLoginThrottle("staff", email);
  await establishSession(result.tokens);
  redirect("/dashboard");
}
