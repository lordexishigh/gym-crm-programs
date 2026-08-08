import { NextResponse, type NextRequest } from "next/server";
import { verifyAccessToken } from "@/lib/identity";
import { refreshAccessToken } from "@/lib/auth/supabase";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth/cookies";
import { SIGN_IN_REASON_PARAM } from "@/lib/auth/sign-in-reason";

/**
 * Session refresh + protected-route gating (edge runtime).
 *
 * Runs only on protected path prefixes (see `matcher`). For each request it:
 *   1. Verifies the access token. If valid, the request proceeds.
 *   2. If invalid/expired but a refresh token is present, transparently
 *      refreshes the session via Supabase and writes the new tokens to BOTH the
 *      forwarded request (so this render sees them) and the response (so the
 *      browser stores them).
 *   3. If there is no usable session, redirects to the appropriate login page.
 *
 * This module is edge-safe: it uses only `jose` (via verifyAccessToken) and
 * `fetch` (via refreshAccessToken) — never `pg` or `next/headers`. Precise
 * role gating and identity resolution happen in the route layouts.
 */

const STAFF_LOGIN = "/login";
const MEMBER_LOGIN = "/portal/login";

function loginPathFor(pathname: string): string {
  return pathname.startsWith("/portal") ? MEMBER_LOGIN : STAFF_LOGIN;
}

async function isValid(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    await verifyAccessToken(token);
    return true;
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const accessToken = req.cookies.get(ACCESS_TOKEN_COOKIE)?.value;

  // Fast path: a currently-valid access token.
  if (await isValid(accessToken)) {
    return NextResponse.next();
  }

  // Try to refresh using the refresh token.
  const refreshToken = req.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
  if (refreshToken) {
    const result = await refreshAccessToken(refreshToken);
    if (result.ok) {
      // Make the new token visible to the current render...
      req.cookies.set(ACCESS_TOKEN_COOKIE, result.tokens.accessToken);
      req.cookies.set(REFRESH_TOKEN_COOKIE, result.tokens.refreshToken);
      const res = NextResponse.next({ request: { headers: req.headers } });
      // ...and persist it to the browser.
      const opts = sessionCookieOptions();
      res.cookies.set(ACCESS_TOKEN_COOKIE, result.tokens.accessToken, opts);
      res.cookies.set(REFRESH_TOKEN_COOKIE, result.tokens.refreshToken, opts);
      return res;
    }
  }

  // No usable session: clear any stale cookies and redirect to login. The
  // original query string is dropped (it belongs to the protected route, not to
  // the form) but the reason is carried so the form can explain itself rather
  // than appearing to have rejected the visitor for nothing.
  const url = req.nextUrl.clone();
  url.pathname = loginPathFor(pathname);
  url.search = "";
  url.searchParams.set(SIGN_IN_REASON_PARAM, "session-expired");
  const res = NextResponse.redirect(url);
  res.cookies.delete(ACCESS_TOKEN_COOKIE);
  res.cookies.delete(REFRESH_TOKEN_COOKIE);
  return res;
}

export const config = {
  // Protect the staff dashboard and the member portal — but NOT the portal
  // login page (members must reach it while unauthenticated).
  matcher: ["/dashboard/:path*", "/portal((?!/login).*)"],
};
