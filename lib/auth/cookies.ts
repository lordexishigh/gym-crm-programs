/**
 * Session cookie names and options.
 *
 * Kept in its own module (no `next/headers` import) so it is edge-safe and can
 * be shared by middleware (edge runtime) and the server-side session helpers.
 */

export const ACCESS_TOKEN_COOKIE = "sb-access-token";
export const REFRESH_TOKEN_COOKIE = "sb-refresh-token";

// The refresh token outlives the (short) access token; this bounds how long a
// session survives without re-authentication.
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** Cookie options shared by every session cookie. `secure` only outside dev. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
