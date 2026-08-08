import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  identityFromClaims,
  sessionRole,
  verifyAccessToken,
  type AccessTokenClaims,
} from "@/lib/identity";
import type { Identity } from "@/lib/db";
import type { AuthTokens } from "@/lib/auth/supabase";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth/cookies";
import { getStaffRole, type StaffRole } from "@/lib/staff";
import { signInPathWithReason } from "@/lib/auth/sign-in-reason";

/**
 * Server-side session: cookie storage + JWT-derived identity.
 *
 * The session lives in two httpOnly cookies (access + refresh token). Identity
 * is ALWAYS derived by verifying the access token server-side — never read from
 * the client, a request body, or an unverified cookie value. Token refresh is
 * handled in middleware (edge); this module is the request-time read path used
 * by Server Components, Server Actions, and Route Handlers.
 */

export type Session = {
  claims: AccessTokenClaims;
  identity: Identity;
  role: "staff" | "member";
};

/**
 * Read and verify the current session from cookies. Returns null when there is
 * no token or the token fails verification (expired/tampered). Never throws on
 * an absent/invalid session — callers decide how to handle "no session".
 */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(ACCESS_TOKEN_COOKIE)?.value;
  if (!token) return null;

  try {
    const claims = await verifyAccessToken(token);
    return {
      claims,
      identity: identityFromClaims(claims),
      role: sessionRole(claims),
    };
  } catch {
    return null;
  }
}

/**
 * Persist a session to cookies. Only callable from a Server Action or Route
 * Handler (Server Components cannot mutate cookies).
 */
export async function establishSession(tokens: AuthTokens): Promise<void> {
  const store = await cookies();
  const opts = sessionCookieOptions();
  store.set(ACCESS_TOKEN_COOKIE, tokens.accessToken, opts);
  store.set(REFRESH_TOKEN_COOKIE, tokens.refreshToken, opts);
}

/** Remove the session cookies (logout). */
export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(ACCESS_TOKEN_COOKIE);
  store.delete(REFRESH_TOKEN_COOKIE);
}

/**
 * Guard for staff-only routes. Redirects to the staff login when there is no
 * valid staff session; a member who lands here is sent to the member portal.
 *
 * The login redirect carries a `reason` so the form can say why the visitor is
 * back on it. Landing on a blank login form with no explanation is
 * indistinguishable from sign-in having silently failed — see
 * lib/auth/sign-in-reason.ts.
 */
export async function requireStaff(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect(signInPathWithReason("/login", "session-expired"));
  if (session.role !== "staff") redirect("/portal");
  return session;
}

/**
 * Guard for owner-only staff routes (billing, plans, revenue). Redirects a
 * signed-in trainer back to the dashboard overview — the owner/trainer split
 * (issue: "staff role separation") is enforced here, server-side, so a
 * trainer can never reach a billing view by guessing the URL; the role check
 * reads `users.role` from the DB (see lib/staff.ts) since the JWT only carries
 * the staff/member audience, not the owner/trainer distinction.
 */
export async function requireOwner(): Promise<Session & { staffRole: StaffRole }> {
  const session = await requireStaff();
  const staffRole = await getStaffRole(session.identity);
  if (staffRole !== "owner") redirect("/dashboard");
  return { ...session, staffRole };
}

/**
 * Guard for member-portal routes. Redirects to the portal login when there is
 * no valid member session; staff are sent to the staff dashboard. A member
 * session must carry a member_id (set at invite acceptance) to resolve a row.
 */
export async function requireMember(): Promise<Session> {
  const session = await getSession();
  if (!session) {
    redirect(signInPathWithReason("/portal/login", "session-expired"));
  }
  if (session.role !== "member") redirect("/dashboard");
  // A member session with no member_id resolves to no Member row, so the portal
  // has nothing to render. The reason distinguishes it from an expired session:
  // signing in again cannot fix it, finishing the invite can.
  if (!session.identity.memberId) {
    redirect(signInPathWithReason("/portal/login", "setup-incomplete"));
  }
  return session;
}
