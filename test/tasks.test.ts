import { describe, expect, it } from "vitest";
import {
  dayStamp,
  dedupeKey,
  retryDelaySeconds,
  shouldRetry,
} from "../lib/tasks";

/**
 * Task-queue rules (migration 0020).
 *
 * These are the parts of the queue that decide whether a member gets one email
 * or seven, so they are pinned here without a database: the dedupe key is the
 * whole idempotency guarantee, and a subtly wrong one drops real work while
 * looking perfectly healthy.
 */

describe("dedupeKey", () => {
  it("joins parts with a colon", () => {
    expect(dedupeKey("member-plan", "abc", "2026-09-01")).toBe(
      "member-plan:abc:2026-09-01",
    );
  });

  it("accepts numbers", () => {
    expect(dedupeKey("attempt", 3)).toBe("attempt:3");
  });

  it("rejects an empty part", () => {
    // An empty part collapses two distinct occasions onto one key, which
    // silently drops the second occasion's work.
    expect(() => dedupeKey("member-plan", "")).toThrow(/part 1 is empty/);
  });

  it("rejects a part containing the separator", () => {
    // Otherwise ("a:b", "c") and ("a", "b:c") produce the same key from
    // different occasions.
    expect(() => dedupeKey("a:b", "c")).toThrow(/contains ':'/);
  });

  it("requires at least one part", () => {
    expect(() => dedupeKey()).toThrow(/at least one part/);
  });
});

describe("dayStamp", () => {
  it("is a UTC calendar day, not a timestamp", () => {
    expect(dayStamp(new Date("2026-09-01T23:14:52.512Z"))).toBe("2026-09-01");
  });

  it("is stable across times within the same UTC day", () => {
    // The property that matters: two sweeps hours apart must produce ONE key
    // for one occasion. A timestamp here would mean an email per sweep.
    const morning = dayStamp(new Date("2026-09-01T06:00:00Z"));
    const evening = dayStamp(new Date("2026-09-01T21:59:59Z"));
    expect(morning).toBe(evening);
  });
});

describe("retryDelaySeconds", () => {
  it("grows exponentially from one minute", () => {
    expect(retryDelaySeconds(1)).toBe(60);
    expect(retryDelaySeconds(2)).toBe(300);
    expect(retryDelaySeconds(3)).toBe(1_500);
  });

  it("is capped at six hours", () => {
    // Unbounded growth would park a task effectively forever while still
    // reporting it as pending.
    expect(retryDelaySeconds(10)).toBe(6 * 60 * 60);
    expect(retryDelaySeconds(1_000)).toBe(6 * 60 * 60);
  });

  it("treats a zero or negative attempt count as the first retry", () => {
    expect(retryDelaySeconds(0)).toBe(60);
    expect(retryDelaySeconds(-5)).toBe(60);
  });
});

describe("shouldRetry", () => {
  it("retries while attempts remain", () => {
    expect(shouldRetry(1, 5)).toBe(true);
    expect(shouldRetry(4, 5)).toBe(true);
  });

  it("stops at the ceiling", () => {
    expect(shouldRetry(5, 5)).toBe(false);
    expect(shouldRetry(6, 5)).toBe(false);
  });

  it("never retries when the ceiling is one", () => {
    // `attempts` is incremented at CLAIM time, so a single-attempt task has
    // attempts === 1 by the time it can fail.
    expect(shouldRetry(1, 1)).toBe(false);
  });
});
