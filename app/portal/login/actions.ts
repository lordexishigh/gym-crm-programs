"use server";

import { redirect } from "next/navigation";
import { signInWithPassword } from "@/lib/auth/supabase";
import { verifyAccessToken, sessionRole, claimValue } from "@/lib/identity";
import { establishSession } from "@/lib/auth/session";
import { guardLoginAttempt, clearLoginThrottle } from "@/lib/auth/login-throttle";

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

  // Throttled before touching the auth service: a blocked attempt costs no
  // GoTrue round-trip and cannot be used to probe account existence.
  const throttled = await guardLoginAttempt("member", email);
  if (throttled) return throttled;

  const result = await signInWithPassword(email, password);
  if (!result.ok) {
    return { error: result.error };
  }

  let role: "staff" | "member";
  let hasMemberId: boolean;
  try {
    const claims = await verifyAccessToken(result.tokens.accessToken);
    role = sessionRole(claims);
    hasMemberId = Boolean(claimValue(claims, "member_id"));
  } catch {
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

  await clearLoginThrottle("member", email);
  await establishSession(result.tokens);
  redirect("/portal");
}
