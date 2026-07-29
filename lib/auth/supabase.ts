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

/**
 * Bounded wait for every call to the auth service.
 *
 * `fetch` does NOT time out on its own: undici caps how long it will wait for
 * response *headers* at ~300s and the Edge runtime has no request bound at all,
 * so an auth service that accepts the TCP connection and then goes silent (a
 * paused/sleeping Supabase project, a half-open connection through a load
 * balancer, a DNS black hole) leaves the request open effectively forever.
 *
 * That hang is not contained where it happens — it propagates to the surfaces a
 * user actually sees:
 *   - `signInWithPassword` runs in the /login Server Action, so the submit
 *     button sits on "Signing in…" indefinitely with no error and no way back.
 *   - `refreshAccessToken` runs in MIDDLEWARE on every protected request, so a
 *     stalled refresh hangs /dashboard and /portal before any page, error
 *     boundary, or loading state can render — the browser just spins.
 *
 * Bounding the wait turns an indefinite hang into a prompt, catchable failure:
 * the caller gets `ok: false` with a real message, the login form shows it, and
 * middleware falls through to its redirect-to-login path instead of blocking.
 * This mirrors the connect/query bounds in `lib/db.ts` — same failure mode, same
 * remedy, applied to the other external dependency on the request path.
 *
 * Overridable via `AUTH_FETCH_TIMEOUT_MS` for slow regions.
 */
function authTimeoutMs(): number {
  const raw = process.env.AUTH_FETCH_TIMEOUT_MS;
  if (!raw) return 8_000;
  const parsed = Number(raw);
  // Ignore junk/negative values rather than silently disabling the bound.
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 8_000;
}

/** True when a rejected `fetch` was aborted by our own timeout signal. */
function isTimeout(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    ((err as { name?: unknown }).name === "TimeoutError" ||
      (err as { name?: unknown }).name === "AbortError")
  );
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
  /*
   * A MISCONFIGURED server must degrade visibly, not crash.
   *
   * `supabaseConfig()` throws when its env vars are absent, and neither login
   * Server Action wraps this call — so the action REJECTED. React then had no
   * returned state to render, the `error.tsx` boundary replaced the whole form
   * with a generic "something went wrong", and the user could not tell a broken
   * deployment from a wrong password. The same throw hit middleware's token
   * refresh on every /dashboard and /portal request.
   *
   * Returning `ok: false` instead routes it through the path every caller
   * already handles: the form shows a real message, and middleware falls through
   * to its redirect-to-login. The operator detail goes to the log, not the page.
   */
  let url: string;
  let publishableKey: string;
  try {
    ({ url, publishableKey } = supabaseConfig());
  } catch (err) {
    console.error(
      "[auth] cannot reach the auth service:",
      err instanceof Error ? err.message : err,
    );
    return {
      ok: false,
      error:
        "Sign-in is unavailable: this server is missing its authentication configuration.",
    };
  }

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
      // Hard ceiling: a silent auth service must fail, not hang (see authTimeoutMs).
      signal: AbortSignal.timeout(authTimeoutMs()),
    });
  } catch (err) {
    // Separate "took too long" from "could not connect" — an operator reading
    // the log, and a user deciding whether to retry, need different answers.
    return {
      ok: false,
      error: isTimeout(err)
        ? "The authentication service timed out. Please try again."
        : "Could not reach the authentication service.",
    };
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
      // Sign-out must not be able to wedge the logout action either: the local
      // cookie clear is what actually ends the session, so a slow revoke is
      // abandoned rather than waited on.
      signal: AbortSignal.timeout(authTimeoutMs()),
    });
  } catch {
    // Best-effort; the session is ended by clearing local cookies regardless.
  }
}
