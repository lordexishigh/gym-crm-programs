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

/**
 * Why a failure is classified, not just described.
 *
 * `error` is written for a visitor to read, which makes it useless for deciding
 * whether anyone should be told. "Invalid email or password" is a normal Tuesday
 * — reporting it would bury the monitoring sink in typos. Every other failure
 * here means the deployment cannot authenticate ANYBODY: the auth service is
 * unreachable, timing out, misconfigured, or answering with something that is
 * not a token. That is a total outage of both sign-in surfaces, and it used to be
 * invisible, because the actions turned it into the same friendly string as a bad
 * password and returned it. Callers switch on this to report the second kind.
 */
export type AuthFailureKind =
  /** The credentials were rejected. Expected; user-fixable; not an incident. */
  | "credentials"
  /** The auth service could not be used at all. Nobody can sign in right now. */
  | "unavailable";

export type AuthResult =
  | { ok: true; tokens: AuthTokens }
  | { ok: false; error: string; kind: AuthFailureKind };

/**
 * User-facing message for "this deployment has no auth service configured".
 *
 * Deliberately not the operator's diagnostic: a visitor can do nothing about a
 * missing environment variable, and naming internal config to an anonymous
 * caller is a needless disclosure. The variable names go to the server log
 * instead (see `supabaseConfig`).
 *
 * It does NOT say "temporarily" or "try again in a moment", which is what it used
 * to say. An absent configuration is not a blip: it will still be absent on the
 * tenth retry, and inviting a retry is what made an unconfigured deployment look
 * like a broken login rather than an unfinished one. It is also the same answer
 * app/ReadinessNotice.tsx gives on the way in, and the two must not contradict
 * each other — a banner saying "retrying will not change this" above a form
 * saying "try again in a moment" is worse than either alone.
 */
const NOT_CONFIGURED =
  "Sign-in is not set up on this deployment, so no account can be used to sign in. " +
  "Trying again will not help — please contact your gym.";

/**
 * Read the auth service configuration, or `null` when it is absent.
 *
 * RETURNS RATHER THAN THROWS, which is the whole point. Every caller below runs
 * on a request path that has no business turning a configuration gap into a
 * crash:
 *
 *   - `signInWithPassword` runs inside the /login and /portal/login Server
 *     Actions. A throw there escapes the action, so `useActionState` never
 *     receives a state — React surfaces the failed action to the nearest error
 *     boundary and the visitor gets "Something went wrong" instead of the
 *     visible message the form is built to show. Every submitted credential,
 *     valid or not, reads as a crash.
 *   - `refreshAccessToken` runs in EDGE MIDDLEWARE on every /dashboard and
 *     /portal request, before any page or boundary can render. A throw there is
 *     a bare 500 on the whole protected surface; returning a failure lets
 *     middleware take its existing redirect-to-login path.
 *
 * So a missing config is reported as `{ ok: false }` with a readable reason,
 * exactly like an unreachable or slow service — the three are indistinguishable
 * to a user and all three deserve a message rather than a stack trace. This
 * mirrors `lib/auth/admin.ts`, which already converts the same gap into a
 * result. Values are trimmed so a whitespace-only variable (a half-filled
 * `.env`, a CI secret that resolved to "") counts as unset rather than
 * producing a request to `https:///auth/v1/token`.
 */
function readAuthEnv(): { url: string; publishableKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !publishableKey) return null;
  return { url: url.replace(/\/$/, ""), publishableKey };
}

function supabaseConfig(): { url: string; publishableKey: string } | null {
  const config = readAuthEnv();
  if (!config) {
    // The operator's half of the message: specific, actionable, in the log.
    console.error(
      "[auth] Sign-in is not configured: NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must both be set (see .env.example). " +
        "Auth requests are being rejected with a user-facing notice.",
    );
    return null;
  }
  return config;
}

/**
 * Whether this deployment can authenticate anyone at all.
 *
 * Exists for the readiness probe (app/api/health/route.ts), and shares
 * `readAuthEnv` with the sign-in path on purpose: a probe that answered from its
 * own copy of the variable names could report "configured" for a deployment
 * whose logins all fail, which is worse than not reporting at all.
 *
 * WHY A DEPLOY NEEDS TO BE TOLD THIS. A deployment missing these variables still
 * renders /login and /portal/login perfectly — they are static pages — and then
 * rejects every credential with `NOT_CONFIGURED`. So it passes an "are the entry
 * routes serving?" check while no one can get past them, leaving the entire
 * dashboard and portal unreachable. That is the exact state repeatedly reported
 * against this project as "the staff authentication entry point is built but the
 * running app doesn't serve it", and nothing observed from outside could tell it
 * apart from a healthy deploy.
 *
 * Deliberately SILENT, unlike `supabaseConfig`: this runs on every health probe,
 * and a monitor polling once a second must not fill the log.
 */
export function authConfigured(): boolean {
  return readAuthEnv() !== null;
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
  // Reached when the service answered but there is no usable token pair — a 5xx,
  // or a 200 whose body is not a session. Either way the service is not working,
  // not the credentials: a rejected password is a 400 and is handled before this.
  return {
    ok: false,
    error: body.error_description || body.msg || body.error || "Authentication failed.",
    kind: "unavailable",
  };
}

async function postToken(
  grant: "password" | "refresh_token",
  payload: Record<string, string>,
): Promise<AuthResult> {
  const config = supabaseConfig();
  if (!config) return { ok: false, error: NOT_CONFIGURED, kind: "unavailable" };
  const { url, publishableKey } = config;
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
      kind: "unavailable",
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
      return { ok: false, error: "Invalid email or password.", kind: "credentials" };
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
    const config = supabaseConfig();
    // Nothing to revoke against; the caller's cookie clear still ends the session.
    if (!config) return;
    const { url, publishableKey } = config;
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
