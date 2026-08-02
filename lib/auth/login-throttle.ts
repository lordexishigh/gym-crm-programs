/**
 * Brute-force throttle for the sign-in Server Actions (security hardening).
 *
 * Before this, `/login` and `/portal/login` accepted password attempts as
 * fast as GoTrue would answer them — an unmetered online guessing oracle
 * against every staff and member account in every tenant. This module is the
 * single place that policy lives, so the two actions stay a few lines each
 * and cannot drift apart.
 *
 * WHY NOT MIDDLEWARE: `middleware.ts` deliberately does NOT match the login
 * routes (its matcher excludes `/portal/login`, and adding `/login` would
 * make its no-session redirect target the very page it redirects to). A
 * Server Action POSTs to the page's own URL, so a middleware-based counter
 * would also have to distinguish the form POST from the GET that renders the
 * form. Guarding inside the actions is both simpler and exact: it counts
 * credential submissions only.
 *
 * TWO BUCKETS, because they stop different attacks:
 *   - per IP     — one host walking a password list (or many accounts).
 *   - per account — credential stuffing for one email from many hosts, which
 *     the IP bucket cannot see at all.
 * Both must pass. A rejection never says WHICH bucket tripped: "the account
 * bucket is full" would confirm the address is registered, and these forms
 * otherwise take care not to leak that.
 *
 * The per-account bucket does allow an attacker to park a known address in a
 * throttled state for one window. That is the accepted trade against
 * credential stuffing and it is bounded and self-healing: the window is
 * minutes, a successful sign-in clears it immediately, and the attacker's own
 * IP bucket fills first. See lib/rate-limit.ts for the single-process caveat.
 */

import { headers } from "next/headers";
import {
  SlidingWindowRateLimiter,
  clientIpFrom,
  formatRetryAfter,
  type RateLimitRule,
} from "@/lib/rate-limit";
import { logger } from "@/lib/observability/logger";

/** Which sign-in surface the attempt came from; keeps the buckets separate. */
export type LoginThrottleScope = "staff" | "member";

const DEFAULT_WINDOW_MS = 5 * 60_000;
const DEFAULT_IP_LIMIT = 10;
/** Stricter than the IP budget: one person does not need 10 tries in 5 minutes. */
const DEFAULT_ACCOUNT_LIMIT = 6;

/**
 * Read a positive-integer override, ignoring junk rather than letting a typo
 * silently disable the guard (`LOGIN_THROTTLE_WINDOW_MS=abc` must not mean
 * "no window"). Mirrors the env handling in lib/db.ts.
 */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function rules(): { ip: RateLimitRule; account: RateLimitRule } {
  const windowMs = positiveIntEnv("LOGIN_THROTTLE_WINDOW_MS", DEFAULT_WINDOW_MS);
  return {
    ip: { limit: positiveIntEnv("LOGIN_THROTTLE_IP_ATTEMPTS", DEFAULT_IP_LIMIT), windowMs },
    account: {
      limit: positiveIntEnv("LOGIN_THROTTLE_ACCOUNT_ATTEMPTS", DEFAULT_ACCOUNT_LIMIT),
      windowMs,
    },
  };
}

/**
 * Limiters are built once and held for the process lifetime — a per-request
 * instance would have no memory and count nothing. Lazy so the env overrides
 * are read on first use rather than at import time (module load order in
 * Next is not something to depend on, and it keeps the module testable).
 */
let limiters: { ip: SlidingWindowRateLimiter; account: SlidingWindowRateLimiter } | null = null;

function get(): { ip: SlidingWindowRateLimiter; account: SlidingWindowRateLimiter } {
  if (!limiters) {
    const rule = rules();
    limiters = {
      ip: new SlidingWindowRateLimiter(rule.ip),
      account: new SlidingWindowRateLimiter(rule.account),
    };
  }
  return limiters;
}

/** Discard all counters (and re-read env on next use). Test/operator helper. */
export function resetLoginThrottle(): void {
  limiters = null;
}

/**
 * Bucket key for the client IP.
 *
 * When no IP header is present the attempts share one `unknown` bucket
 * rather than skipping the check — an unauthenticated endpoint must not be
 * left unmetered just because a header is missing, which is precisely the
 * state an attacker would try to induce. In production behind Vercel a
 * platform header is always present; locally (no proxy) this is the bucket
 * that applies.
 */
async function ipKey(scope: LoginThrottleScope): Promise<string> {
  const ip = clientIpFrom(await headers());
  return `${scope}:ip:${ip ?? "unknown"}`;
}

function accountKey(scope: LoginThrottleScope, email: string): string {
  // Case-insensitive: addresses are matched case-insensitively upstream, so
  // varying the case must not hand out a fresh budget.
  return `${scope}:account:${email.trim().toLowerCase()}`;
}

/**
 * Gate one credential submission.
 *
 * Returns `null` when the attempt may proceed (and records it), or an object
 * carrying the user-facing message when it must be refused. The shape
 * matches the `LoginState` both actions already return, so a caller can
 * `return` it directly and the existing `role="alert"` markup renders it
 * unchanged.
 *
 * Call this BEFORE touching the auth service: the point is that a throttled
 * request costs no GoTrue round-trip.
 */
export async function guardLoginAttempt(
  scope: LoginThrottleScope,
  email: string,
): Promise<{ error: string } | null> {
  const { ip, account } = get();

  const byIp = ip.consume(await ipKey(scope));
  // Check the IP budget first and DO NOT charge the account bucket when it
  // is already exhausted — otherwise a single attacking host would also fill
  // the account bucket of every address it names, widening a self-inflicted
  // block into a lockout of real users.
  const byAccount = byIp.allowed ? account.consume(accountKey(scope, email)) : null;

  const blocked = !byIp.allowed ? byIp : byAccount && !byAccount.allowed ? byAccount : null;
  if (!blocked || blocked.allowed) return null;

  // Security-relevant, so it belongs in the logs — but neither the address
  // nor the IP is recorded. Both are personal data under GDPR (recital 30
  // covers IP addresses) and the operational question is "is a surface being
  // sprayed?", which the scope and rate answer on their own.
  logger.warn("sign-in attempt throttled", {
    scope,
    reason: byIp.allowed ? "account" : "ip",
    retryAfterSeconds: blocked.retryAfterSeconds,
  });

  return {
    // One message for both buckets, and no mention of which — see the
    // enumeration note in this module's header.
    error: `Too many sign-in attempts. Please wait ${formatRetryAfter(
      blocked.retryAfterSeconds,
    )} and try again.`,
  };
}

/**
 * Clear both buckets after a SUCCESSFUL sign-in, so several mistyped
 * passwords followed by the right one leave no penalty behind. Only correct
 * credentials reach this, so it cannot be used to reset the counter by
 * guessing.
 */
export async function clearLoginThrottle(
  scope: LoginThrottleScope,
  email: string,
): Promise<void> {
  const { ip, account } = get();
  ip.reset(await ipKey(scope));
  account.reset(accountKey(scope, email));
}
