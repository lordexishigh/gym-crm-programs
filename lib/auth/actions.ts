"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ACCESS_TOKEN_COOKIE } from "@/lib/auth/cookies";
import { clearSession } from "@/lib/auth/session";
import { signOut } from "@/lib/auth/supabase";

/**
 * Log the current user out: revoke the session at Supabase (best-effort) and
 * clear the local session cookies, then send them to the given login page.
 * Used by both the staff dashboard and the member portal shells.
 */
export async function logoutAction(formData: FormData): Promise<void> {
  const redirectTo = String(formData.get("redirectTo") ?? "/login");

  const token = (await cookies()).get(ACCESS_TOKEN_COOKIE)?.value;
  if (token) {
    await signOut(token);
  }
  await clearSession();

  // Only allow same-origin path redirects (defense against open-redirect).
  // Must start with a single "/" and NOT "//" or "/\" — both of which the
  // browser resolves to an external origin via `Location`.
  const safe = /^\/(?![/\\])/.test(redirectTo) ? redirectTo : "/login";
  redirect(safe);
}
