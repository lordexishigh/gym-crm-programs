/**
 * In-process sliding-window rate limiter (beta-hardening-002).
 *
 * Built for the credential-brute-force guard on the two sign-in Server Actions
 * (see lib/auth/login-throttle.ts), which before this had no throttle at all: an
 * attacker could post the /login form as fast as the auth service would answer.
 *
 * WHY A SLIDING WINDOW rather than a fixed one: a fixed window lets a caller
 * spend its whole budget at the end of window N and again at the start of window
 * N+1 — a 2x burst across the boundary, which is exactly the shape a password
 * sprayer produces. Keeping the individual hit timestamps costs a small array
 * per key and removes that edge entirely.
 *
 * WHY IN-PROCESS: the project has no Redis/Upstash dependency and adding one to
 * gate a login form would be the largest new piece of infrastructure in the
 * stack. The honest trade-off, stated plainly because it bounds what this can
 * promise: on a multi-instance/serverless deployment each instance keeps its own
 * counters, so the effective global limit is (instances x limit) per window.
 * That still converts an unbounded brute force into a bounded one — the property
 * that actually matters — and it is a strict improvement over no limit. The
 * `RateLimiterStore` shape below is deliberately narrow so a shared backend can
 * be dropped in later without touching a single call site.
 *
 * Deliberately dependency-free and free of `next/*` imports so it is unit
 * testable in isolation and safe to import from any runtime (Node or Edge).
 */

/** How many attempts are allowed per rolling window. */
export type RateLimitRule = {
  /** Maximum attempts permitted within `windowMs`. */
  limit: number;
  /** Length of the rolling window, in milliseconds. */
  windowMs: number;
};

export type RateLimitDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

/** The narrow surface a call site needs — see the note on swapping backends. */
export type RateLimiterStore = {
  consume(key: string): RateLimitDecision;
  reset(key: string): void;
};

/**
 * Cap on tracked keys, so a spray across many forged IPs cannot grow the map
 * without bound (the map is the only state this holds, and it lives for the
 * lifetime of the server process). On overflow the least-recently-active keys
 * are dropped: an evicted key is one that has not been seen in a while, so it
 * was near the bottom of its window anyway.
 */
const DEFAULT_MAX_KEYS = 10_000;

export type RateLimiterOptions = {
  /** Injectable clock, in ms. Defaults to `Date.now`. Tests pass a fake. */
  clock?: () => number;
  /** Override the tracked-key ceiling. */
  maxKeys?: number;
};

export class SlidingWindowRateLimiter implements RateLimiterStore {
  private readonly rule: RateLimitRule;
  private readonly clock: () => number;
  private readonly maxKeys: number;
  /** key -> ascending hit timestamps inside the current window. */
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(rule: RateLimitRule, options: RateLimiterOptions = {}) {
    if (!Number.isFinite(rule.limit) || rule.limit < 1) {
      throw new Error("rate limit must be a positive number of attempts");
    }
    if (!Number.isFinite(rule.windowMs) || rule.windowMs < 1) {
      throw new Error("rate limit window must be a positive number of ms");
    }
    this.rule = { limit: Math.floor(rule.limit), windowMs: Math.floor(rule.windowMs) };
    this.clock = options.clock ?? (() => Date.now());
    this.maxKeys = Math.max(1, Math.floor(options.maxKeys ?? DEFAULT_MAX_KEYS));
  }

  /**
   * Record an attempt against `key` and report whether it is permitted.
   *
   * A REJECTED ATTEMPT IS NOT RECORDED. That is the important detail: if blocked
   * attempts were also written to the window, a caller hammering the endpoint
   * would keep pushing its own oldest-hit forward and could never come back —
   * a permanent lockout triggered by the attacker, on a key (the client IP) that
   * a legitimate user may share via NAT. Not recording them means the window
   * drains on schedule and the sustained rate is exactly `limit` per `windowMs`,
   * which is the throttle we wanted.
   */
  consume(key: string): RateLimitDecision {
    const now = this.clock();
    this.sweep(now);

    const cutoff = now - this.rule.windowMs;
    // Timestamps are appended in clock order, so everything expired is a prefix.
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);

    if (recent.length >= this.rule.limit) {
      // Keep the pruned array so the retry estimate stays accurate, and refresh
      // recency so this key is not the one evicted under pressure.
      this.touch(key, recent);
      const oldest = recent[0] as number;
      const waitMs = oldest + this.rule.windowMs - now;
      return {
        allowed: false,
        // Always at least 1s: "retry in 0 seconds" invites an immediate retry
        // that is still rejected.
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      };
    }

    recent.push(now);
    this.touch(key, recent);
    this.evictIfOverCapacity();
    return { allowed: true, remaining: this.rule.limit - recent.length };
  }

  /**
   * Forget `key` entirely. Called after a SUCCESSFUL sign-in so a member who
   * mistyped their password several times is not throttled once they get it
   * right — the limiter exists to bound guessing, not to punish typos.
   */
  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Drop all state. Test helper; also useful for a manual operator reset. */
  clear(): void {
    this.hits.clear();
    this.lastSweep = 0;
  }

  /** Number of tracked keys. Exposed for the memory-ceiling tests. */
  get size(): number {
    return this.hits.size;
  }

  /** Re-insert so Map iteration order reflects recency (drives eviction). */
  private touch(key: string, hits: number[]): void {
    this.hits.delete(key);
    this.hits.set(key, hits);
  }

  /**
   * Drop keys whose every hit has expired. Runs at most once per window: the
   * per-key prune in `consume` already keeps individual entries correct, so this
   * only reclaims keys that stopped being asked about, and doing it on every
   * call would make each request O(tracked keys).
   */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.rule.windowMs) return;
    this.lastSweep = now;
    const cutoff = now - this.rule.windowMs;
    for (const [key, hits] of this.hits) {
      if (hits.length === 0 || (hits[hits.length - 1] as number) <= cutoff) {
        this.hits.delete(key);
      }
    }
  }

  /** Enforce the key ceiling by dropping the least-recently-active keys. */
  private evictIfOverCapacity(): void {
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next();
      if (oldest.done) return;
      this.hits.delete(oldest.value);
    }
  }
}

/** Minimal read-only view of a request's headers (Next's `ReadonlyHeaders` fits). */
export type HeaderReader = { get(name: string): string | null | undefined };

/**
 * Header precedence for the client IP, most trustworthy first.
 *
 * `x-forwarded-for` is client-settable in principle, so a limiter keyed on it
 * naively is bypassable by sending a fresh value per request. The
 * platform-generated headers come first because the proxy writes them itself and
 * a client cannot forge them: Vercel sets `x-vercel-forwarded-for` and
 * `x-real-ip`, Cloudflare sets `cf-connecting-ip`. `x-forwarded-for` is the last
 * resort (and behind Vercel it is overwritten by the edge anyway).
 */
const IP_HEADERS = [
  "x-vercel-forwarded-for",
  "cf-connecting-ip",
  "x-real-ip",
  "x-forwarded-for",
] as const;

/** Strip an `:port` suffix from an IPv4 address; leave IPv6 (many colons) alone. */
function stripPort(value: string): string {
  const parts = value.split(":");
  return parts.length === 2 && /^\d{1,3}(\.\d{1,3}){3}$/.test(parts[0] as string)
    ? (parts[0] as string)
    : value;
}

/**
 * Best-effort client IP from request headers, or `null` when none is present.
 *
 * Takes the FIRST entry of a comma-separated list: proxies append, so the
 * left-most value is the original client. Callers must decide what to do with
 * `null` — see the shared-bucket note in lib/auth/login-throttle.ts.
 */
export function clientIpFrom(headers: HeaderReader): string | null {
  for (const header of IP_HEADERS) {
    const raw = headers.get(header);
    if (!raw) continue;
    const first = raw.split(",")[0]?.trim();
    if (!first) continue;
    // `[::1]:3000` -> `::1`
    const unbracketed = first.startsWith("[")
      ? (first.slice(1).split("]")[0] as string)
      : stripPort(first);
    if (unbracketed) return unbracketed;
  }
  return null;
}

/** "45 seconds" / "3 minutes" — for the user-facing retry message. */
export function formatRetryAfter(seconds: number): string {
  const safe = Math.max(1, Math.ceil(seconds));
  if (safe < 60) return `${safe} second${safe === 1 ? "" : "s"}`;
  const minutes = Math.ceil(safe / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
