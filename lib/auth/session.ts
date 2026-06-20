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
 */
export async function requireStaff(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "staff") redirect("/portal");
  return session;
}

/**
 * Guard for member-portal routes. Redirects to the portal login when there is
 * no valid member session; staff are sent to the staff dashboard. A member
 * session must carry a member_id (set at invite acceptance) to resolve a row.
 */
export async function requireMember(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/portal/login");
  if (session.role !== "member") redirect("/dashboard");
  if (!session.identity.memberId) redirect("/portal/login");
  return session;
}
