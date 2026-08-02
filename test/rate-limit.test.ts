import { describe, expect, it } from "vitest";
import {
  SlidingWindowRateLimiter,
  clientIpFrom,
  formatRetryAfter,
} from "@/lib/rate-limit";

describe("SlidingWindowRateLimiter", () => {
  it("allows attempts up to the limit and then blocks", () => {
    const limiter = new SlidingWindowRateLimiter({ limit: 3, windowMs: 1000 });
    expect(limiter.consume("k").allowed).toBe(true);
    expect(limiter.consume("k").allowed).toBe(true);
    expect(limiter.consume("k").allowed).toBe(true);
    const blocked = limiter.consume("k");
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
  });

  it("tracks separate keys independently", () => {
    const limiter = new SlidingWindowRateLimiter({ limit: 1, windowMs: 1000 });
    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(false);
    // A different key has its own budget.
    expect(limiter.consume("b").allowed).toBe(true);
  });

  it("does not record a rejected attempt (no self-inflicted permanent lockout)", () => {
    let now = 0;
    const limiter = new SlidingWindowRateLimiter(
      { limit: 1, windowMs: 100 },
      { clock: () => now },
    );
    expect(limiter.consume("k").allowed).toBe(true);
    // Hammer the endpoint well past the window without ever succeeding again.
    for (let i = 0; i < 10; i++) {
      now += 10;
      limiter.consume("k");
    }
    // Once the window has fully elapsed since the one recorded hit, a fresh
    // attempt is allowed again — the block did not extend itself.
    now = 200;
    expect(limiter.consume("k").allowed).toBe(true);
  });

  it("slides the window rather than resetting on a fixed boundary", () => {
    let now = 0;
    const limiter = new SlidingWindowRateLimiter(
      { limit: 2, windowMs: 100 },
      { clock: () => now },
    );
    expect(limiter.consume("k").allowed).toBe(true);
    now = 50;
    expect(limiter.consume("k").allowed).toBe(true);
    // Still within 100ms of the first hit at t=0, so the budget is spent.
    now = 99;
    expect(limiter.consume("k").allowed).toBe(false);
    // The t=0 hit has now aged out; the t=50 hit is still active, leaving room
    // for exactly one more.
    now = 101;
    expect(limiter.consume("k").allowed).toBe(true);
  });

  it("reset() clears a key's history", () => {
    const limiter = new SlidingWindowRateLimiter({ limit: 1, windowMs: 1000 });
    expect(limiter.consume("k").allowed).toBe(true);
    expect(limiter.consume("k").allowed).toBe(false);
    limiter.reset("k");
    expect(limiter.consume("k").allowed).toBe(true);
  });

  it("evicts least-recently-active keys once over the configured cap", () => {
    const limiter = new SlidingWindowRateLimiter(
      { limit: 10, windowMs: 1000 },
      { maxKeys: 2 },
    );
    limiter.consume("a");
    limiter.consume("b");
    limiter.consume("c");
    expect(limiter.size).toBeLessThanOrEqual(2);
  });

  it("rejects a non-positive limit or window", () => {
    expect(() => new SlidingWindowRateLimiter({ limit: 0, windowMs: 1000 })).toThrow();
    expect(() => new SlidingWindowRateLimiter({ limit: 1, windowMs: 0 })).toThrow();
  });
});

describe("clientIpFrom", () => {
  function headersOf(map: Record<string, string>) {
    return { get: (name: string) => map[name] ?? null };
  }

  it("prefers the Vercel-generated header over x-forwarded-for", () => {
    const ip = clientIpFrom(
      headersOf({
        "x-vercel-forwarded-for": "203.0.113.5",
        "x-forwarded-for": "198.51.100.1",
      }),
    );
    expect(ip).toBe("203.0.113.5");
  });

  it("takes the first, left-most entry of a comma-separated list", () => {
    const ip = clientIpFrom(headersOf({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }));
    expect(ip).toBe("203.0.113.5");
  });

  it("strips a trailing :port from an IPv4 address", () => {
    const ip = clientIpFrom(headersOf({ "x-real-ip": "203.0.113.5:54321" }));
    expect(ip).toBe("203.0.113.5");
  });

  it("returns null when no IP header is present", () => {
    expect(clientIpFrom(headersOf({}))).toBeNull();
  });
});

describe("formatRetryAfter", () => {
  it("formats sub-minute durations in seconds", () => {
    expect(formatRetryAfter(1)).toBe("1 second");
    expect(formatRetryAfter(45)).toBe("45 seconds");
  });

  it("formats minute-scale durations in minutes", () => {
    expect(formatRetryAfter(61)).toBe("2 minutes");
    expect(formatRetryAfter(120)).toBe("2 minutes");
  });
});
