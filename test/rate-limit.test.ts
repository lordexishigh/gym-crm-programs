import { describe, expect, it } from "vitest";
import {
  SlidingWindowRateLimiter,
  clientIpFrom,
  formatRetryAfter,
} from "@/lib/rate-limit";

/**
 * The brute-force guard's primitive (beta-hardening-002).
 *
 * The /login and /portal/login Server Actions had no throttle at all, so this is
 * the piece that turns an unbounded online password-guessing oracle into a
 * bounded one. Every property below is one an attacker would otherwise use:
 * bursting across a window boundary, hammering to hold themselves (or a
 * legitimate NAT-sharing user) in permanent lockout, forging a fresh IP header
 * per request, or spraying enough distinct keys to exhaust the server's memory.
 *
 * The clock is injected rather than faked globally so the window can be advanced
 * deterministically without timers.
 */

/** A manually-advanced clock. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("SlidingWindowRateLimiter", () => {
  it("allows exactly `limit` attempts, then refuses", () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowRateLimiter(
      { limit: 3, windowMs: 60_000 },
      { clock: clock.now },
    );

    expect(limiter.consume("k")).toEqual({ allowed: true, remaining: 2 });
    expect(limiter.consume("k")).toEqual({ allowed: true, remaining: 1 });
    expect(limiter.consume("k")).toEqual({ allowed: true, remaining: 0 });
    expect(limiter.consume("k").allowed).toBe(false);
  });

  it("keys are independent — one caller cannot throttle another", () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowRateLimiter(
      { limit: 1, windowMs: 60_000 },
      { clock: clock.now },
    );

    limiter.consume("a");
    expect(limiter.consume("a").allowed).toBe(false);
    // A different IP / account is unaffected.
    expect(limiter.consume("b").allowed).toBe(true);
  });

  it("reports a retry-after that actually reflects when a slot frees", () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowRateLimiter(
      { limit: 2, windowMs: 60_000 },
      { clock: clock.now },
    );

    limiter.consume("k"); // t=0
    clock.advance(10_000);
    limiter.consume("k"); // t=10s

    const blocked = limiter.consume("k");
    expect(blocked.allowed).toBe(false);
    // The oldest hit was at t=0, so the window frees it 60s later — 50s from now.
    if (!blocked.allowed) expect(blocked.retryAfterSeconds).toBe(50);

    // Waiting that long really does free a slot.
    clock.advance(50_001);
    expect(limiter.consume("k").allowed).toBe(true);
  });

  it("never reports a retry-after of 0 (which would invite an instant retry)", () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowRateLimiter(
      { limit: 1, windowMs: 500 },
      { clock: clock.now },
    );

    limiter.consume("k");
    clock.advance(499);
    const blocked = limiter.consume("k");
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("slides rather than resetting — no double-budget burst at a boundary", () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowRateLimiter(
      { limit: 5, windowMs: 60_000 },
      { clock: clock.now },
    );

    // Spend the whole budget late in the window (t=55s..59s).
    clock.advance(55_000);
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.consume("k").allowed).toBe(true);
      clock.advance(1_000);
    }

    // A FIXED window would roll over at t=60s and hand out 5 more immediately —
    // 10 attempts in ~5 seconds. A sliding one still remembers these hits.
    clock.advance(1_000); // t=61s
    expect(limiter.consume("k").allowed).toBe(false);
  });

  it("does not extend the block when a caller keeps hammering", () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowRateLimiter(
      { limit: 2, windowMs: 10_000 },
      { clock: clock.now },
    );

    limiter.consume("k"); // t=0
    limiter.consume("k"); // t=0

    // Hammer continuously for most of the window. If rejected attempts were
    // recorded, each would push the oldest hit forward and the key would never
    // recover — a permanent lockout an attacker could inflict on a shared IP.
    for (let t = 0; t < 9_000; t += 500) {
      clock.advance(500);
      expect(limiter.consume("k").allowed).toBe(false);
    }

    // The window still drains on its original schedule.
    clock.advance(1_500);
    expect(limiter.consume("k").allowed).toBe(true);
  });

  it("reset() clears a key — a correct password erases earlier typos", () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowRateLimiter(
      { limit: 2, windowMs: 60_000 },
      { clock: clock.now },
    );

    limiter.consume("k");
    limiter.consume("k");
    expect(limiter.consume("k").allowed).toBe(false);

    limiter.reset("k");
    expect(limiter.consume("k").allowed).toBe(true);
  });

  it("bounds memory: a spray across many keys cannot grow without limit", () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowRateLimiter(
      { limit: 5, windowMs: 60_000 },
      { clock: clock.now, maxKeys: 50 },
    );

    for (let i = 0; i < 5_000; i += 1) limiter.consume(`ip-${i}`);

    expect(limiter.size).toBeLessThanOrEqual(50);
    // Still functional after eviction.
    expect(limiter.consume("fresh").allowed).toBe(true);
  });

  it("evicts by least-recent activity, so an ACTIVE attacker is not freed", () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowRateLimiter(
      { limit: 1, windowMs: 60_000 },
      { clock: clock.now, maxKeys: 2 },
    );

    limiter.consume("attacker"); // spends its budget
    limiter.consume("idle");
    // A refused attempt still counts as activity, so the key stays hot.
    expect(limiter.consume("attacker").allowed).toBe(false);

    // Now push past the ceiling. The victim of eviction must be `idle` — the
    // least recently active — and NOT the key that is currently being refused,
    // otherwise an attacker could clear their own block just by generating
    // enough unrelated keys.
    limiter.consume("newcomer");
    expect(limiter.size).toBe(2);
    expect(limiter.consume("attacker").allowed).toBe(false);
  });

  it("forgets keys that go quiet, so idle state is reclaimed", () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowRateLimiter(
      { limit: 5, windowMs: 1_000 },
      { clock: clock.now },
    );

    limiter.consume("a");
    limiter.consume("b");
    expect(limiter.size).toBe(2);

    // Well past the window: the periodic sweep drops fully-expired keys.
    clock.advance(5_000);
    limiter.consume("c");
    expect(limiter.size).toBe(1);
  });

  it("rejects a nonsensical rule instead of silently not limiting", () => {
    expect(() => new SlidingWindowRateLimiter({ limit: 0, windowMs: 1_000 })).toThrow();
    expect(() => new SlidingWindowRateLimiter({ limit: 5, windowMs: 0 })).toThrow();
    expect(
      () => new SlidingWindowRateLimiter({ limit: Number.NaN, windowMs: 1_000 }),
    ).toThrow();
  });
});

describe("clientIpFrom", () => {
  const h = (values: Record<string, string>) => new Headers(values);

  it("prefers platform-set headers over the client-settable x-forwarded-for", () => {
    // A forged x-forwarded-for must not win: if it did, an attacker could send a
    // fresh value per request and get an unlimited budget.
    expect(
      clientIpFrom(
        h({ "x-forwarded-for": "9.9.9.9", "x-vercel-forwarded-for": "203.0.113.7" }),
      ),
    ).toBe("203.0.113.7");
    expect(
      clientIpFrom(h({ "x-forwarded-for": "9.9.9.9", "x-real-ip": "203.0.113.8" })),
    ).toBe("203.0.113.8");
  });

  it("takes the left-most entry of a proxy chain (the original client)", () => {
    expect(clientIpFrom(h({ "x-forwarded-for": "203.0.113.9, 70.41.3.18, 10.0.0.1" }))).toBe(
      "203.0.113.9",
    );
  });

  it("normalises so one client cannot occupy several buckets", () => {
    expect(clientIpFrom(h({ "x-forwarded-for": "203.0.113.9:41234" }))).toBe("203.0.113.9");
    expect(clientIpFrom(h({ "x-forwarded-for": "[2001:db8::1]:443" }))).toBe("2001:db8::1");
    expect(clientIpFrom(h({ "x-forwarded-for": "  203.0.113.9  " }))).toBe("203.0.113.9");
  });

  it("keeps a bare IPv6 address intact", () => {
    expect(clientIpFrom(h({ "x-real-ip": "2001:db8::1" }))).toBe("2001:db8::1");
  });

  it("returns null when there is no usable header", () => {
    expect(clientIpFrom(h({}))).toBeNull();
    expect(clientIpFrom(h({ "x-forwarded-for": "" }))).toBeNull();
    expect(clientIpFrom(h({ "x-forwarded-for": " , " }))).toBeNull();
  });
});

describe("formatRetryAfter", () => {
  it("reads naturally in the login error message", () => {
    expect(formatRetryAfter(1)).toBe("1 second");
    expect(formatRetryAfter(45)).toBe("45 seconds");
    expect(formatRetryAfter(60)).toBe("1 minute");
    expect(formatRetryAfter(61)).toBe("2 minutes");
    expect(formatRetryAfter(300)).toBe("5 minutes");
  });

  it("never says zero", () => {
    expect(formatRetryAfter(0)).toBe("1 second");
    expect(formatRetryAfter(-5)).toBe("1 second");
  });
});
