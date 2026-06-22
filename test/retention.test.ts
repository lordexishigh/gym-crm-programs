import { describe, expect, it } from "vitest";
import {
  PLATFORM_DEFAULT_RETENTION_DAYS,
  parseRetentionDays,
  resolveRetentionDays,
  retentionCutoff,
} from "../lib/retention";

/**
 * Unit tests for retention-policy resolution (beta-gdpr-002).
 *
 * These are pure (no DB, no env mutation needed for the resolver — env is passed
 * in), asserting the documented precedence (gym → env → default), the
 * fail-safe parsing (a typo never disables retention), and the cutoff maths.
 */
describe("parseRetentionDays", () => {
  it("accepts positive integers from numbers and numeric strings", () => {
    expect(parseRetentionDays(30)).toBe(30);
    expect(parseRetentionDays("90")).toBe(90);
    expect(parseRetentionDays(7.9)).toBe(7); // floored
  });

  it("treats absent/blank/invalid/non-positive values as unset (null)", () => {
    expect(parseRetentionDays(undefined)).toBeNull();
    expect(parseRetentionDays(null)).toBeNull();
    expect(parseRetentionDays("")).toBeNull();
    expect(parseRetentionDays("   ")).toBeNull();
    expect(parseRetentionDays("abc")).toBeNull();
    expect(parseRetentionDays(0)).toBeNull();
    expect(parseRetentionDays(-5)).toBeNull();
  });
});

describe("resolveRetentionDays precedence", () => {
  it("prefers the per-gym override when set", () => {
    expect(resolveRetentionDays(30, "90")).toBe(30);
  });

  it("falls back to the env value when no gym override", () => {
    expect(resolveRetentionDays(null, "90")).toBe(90);
    expect(resolveRetentionDays(undefined, "90")).toBe(90);
  });

  it("falls back to the built-in default when neither is valid", () => {
    expect(resolveRetentionDays(null, undefined)).toBe(
      PLATFORM_DEFAULT_RETENTION_DAYS,
    );
    expect(resolveRetentionDays("oops", "also-bad")).toBe(
      PLATFORM_DEFAULT_RETENTION_DAYS,
    );
  });

  it("a typo'd gym override does not disable retention (falls through)", () => {
    expect(resolveRetentionDays("oops", "90")).toBe(90);
  });
});

describe("retentionCutoff", () => {
  it("subtracts the retention window from now", () => {
    const now = new Date("2026-06-22T00:00:00.000Z");
    const cutoff = retentionCutoff(now, 30);
    expect(cutoff.toISOString()).toBe("2026-05-23T00:00:00.000Z");
  });
});
