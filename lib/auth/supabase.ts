/**
 * Minimal Supabase Auth (GoTrue) REST client.
 *
 * The project intentionally has no `@supabase/supabase-js` dependency: the
 * server already verifies Supabase-issued access tokens against the project's
 * JWKS with `jose` (see lib/identity.ts), so authentication only needs GoTrue's
 * token/logout
 * endpoints. Talking to them over `fetch` keeps this edge-safe (usable from
 * middleware) and dependency-free.
 *
 * Identity is NEVER trusted from these responses' bodies directly — the
 * returned access token is always re-verified server-side before its claims
 * are used (lib/auth/session.ts).
 */

/** Tokens returned by a successful GoTrue token grant. */
export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in seconds. */
  expiresIn: number;
};

export type AuthResult =
  | { ok: true; tokens: AuthTokens }
  | { ok: false; error: string };

function supabaseConfig(): { url: string; publishableKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set (see .env.example).",
    );
  }
  return { url: url.replace(/\/$/, ""), publishableKey };
}

type GoTrueTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
  msg?: string;
};

function toTokens(body: GoTrueTokenResponse): AuthResult {
  if (body.access_token && body.refresh_token) {
    return {
      ok: true,
      tokens: {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresIn: body.expires_in ?? 3600,
      },
    };
  }
  return {
    ok: false,
    error: body.error_description || body.msg || body.error || "Authentication failed.",
  };
}

async function postToken(
  grant: "password" | "refresh_token",
  payload: Record<string, string>,
): Promise<AuthResult> {
  const { url, publishableKey } = supabaseConfig();
  let res: Response;
  try {
    res = await fetch(`${url}/auth/v1/token?grant_type=${grant}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: publishableKey,
      },
      body: JSON.stringify(payload),
      // Auth must never be served from a cache.
      cache: "no-store",
    });
  } catch {
    return { ok: false, error: "Could not reach the authentication service." };
  }

  let body: GoTrueTokenResponse;
  try {
    body = (await res.json()) as GoTrueTokenResponse;
  } catch {
    body = {};
  }

  if (!res.ok) {
    // Avoid leaking which factor was wrong on a 400 (invalid credentials).
    if (res.status === 400) {
      return { ok: false, error: "Invalid email or password." };
    }
    return toTokens(body);
  }
  return toTokens(body);
}

/** Exchange email + password for a session (GoTrue `grant_type=password`). */
export function signInWithPassword(
  email: string,
  password: string,
): Promise<AuthResult> {
  return postToken("password", { email, password });
}

/** Exchange a refresh token for a fresh session (`grant_type=refresh_token`). */
export function refreshAccessToken(refreshToken: string): Promise<AuthResult> {
  return postToken("refresh_token", { refresh_token: refreshToken });
}

/**
 * Revoke the session server-side (best-effort). Clearing the cookies is what
 * actually ends the session locally, so failures here are swallowed.
 */
export async function signOut(accessToken: string): Promise<void> {
  try {
    const { url, publishableKey } = supabaseConfig();
    await fetch(`${url}/auth/v1/logout`, {
      method: "POST",
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
    });
  } catch {
    // Best-effort; the session is ended by clearing local cookies regardless.
  }
}
