import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `guardLoginAttempt` reads the client IP via `next/headers`, which throws
 * outside a request context. Stub it so the module can be exercised directly,
 * with the returned IP controllable per test.
 */
let currentIp: string | null = "203.0.113.9";
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => (name === "x-vercel-forwarded-for" ? currentIp : null),
  }),
}));

import {
  guardLoginAttempt,
  clearLoginThrottle,
  resetLoginThrottle,
} from "@/lib/auth/login-throttle";

const ENV_KEYS = [
  "LOGIN_THROTTLE_WINDOW_MS",
  "LOGIN_THROTTLE_IP_ATTEMPTS",
  "LOGIN_THROTTLE_ACCOUNT_ATTEMPTS",
] as const;

function setLimits(windowMs: number, ipLimit: number, accountLimit: number) {
  process.env.LOGIN_THROTTLE_WINDOW_MS = String(windowMs);
  process.env.LOGIN_THROTTLE_IP_ATTEMPTS = String(ipLimit);
  process.env.LOGIN_THROTTLE_ACCOUNT_ATTEMPTS = String(accountLimit);
  resetLoginThrottle();
}

describe("guardLoginAttempt / clearLoginThrottle", () => {
  beforeEach(() => {
    currentIp = "203.0.113.9";
    setLimits(60_000, 10, 3);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    resetLoginThrottle();
  });

  it("allows attempts under the per-account limit", async () => {
    expect(await guardLoginAttempt("staff", "owner@demo.local")).toBeNull();
    expect(await guardLoginAttempt("staff", "owner@demo.local")).toBeNull();
    expect(await guardLoginAttempt("staff", "owner@demo.local")).toBeNull();
  });

  it("blocks once the per-account limit is exceeded, with a friendly message", async () => {
    for (let i = 0; i < 3; i++) {
      expect(await guardLoginAttempt("staff", "owner@demo.local")).toBeNull();
    }
    const blocked = await guardLoginAttempt("staff", "owner@demo.local");
    expect(blocked).not.toBeNull();
    expect(blocked?.error).toMatch(/too many sign-in attempts/i);
  });

  it("treats the account key case-insensitively", async () => {
    for (let i = 0; i < 3; i++) {
      expect(await guardLoginAttempt("staff", "Owner@Demo.Local")).toBeNull();
    }
    const blocked = await guardLoginAttempt("staff", "owner@demo.local");
    expect(blocked).not.toBeNull();
  });

  it("keeps staff and member scopes in separate buckets for the same address", async () => {
    for (let i = 0; i < 3; i++) {
      expect(await guardLoginAttempt("staff", "shared@demo.local")).toBeNull();
    }
    expect(await guardLoginAttempt("staff", "shared@demo.local")).not.toBeNull();
    // The member scope has its own, unspent budget.
    expect(await guardLoginAttempt("member", "shared@demo.local")).toBeNull();
  });

  it("clearLoginThrottle resets the account bucket after a successful sign-in", async () => {
    for (let i = 0; i < 3; i++) {
      expect(await guardLoginAttempt("staff", "owner@demo.local")).toBeNull();
    }
    await clearLoginThrottle("staff", "owner@demo.local");
    expect(await guardLoginAttempt("staff", "owner@demo.local")).toBeNull();
  });

  it("does not charge the account bucket once the IP bucket is already exhausted", async () => {
    setLimits(60_000, 1, 10);
    expect(await guardLoginAttempt("staff", "a@demo.local")).toBeNull();
    // The IP is now spent; a different account from the same IP is blocked by
    // the IP bucket without touching its own account bucket.
    const blocked = await guardLoginAttempt("staff", "b@demo.local");
    expect(blocked).not.toBeNull();
    // Confirm the account bucket for "b" is still fresh: from a fresh IP it
    // is allowed.
    currentIp = "198.51.100.7";
    expect(await guardLoginAttempt("staff", "b@demo.local")).toBeNull();
  });

  it("buckets attempts with no IP header under a shared 'unknown' key rather than skipping the check", async () => {
    currentIp = null;
    setLimits(60_000, 2, 10);
    expect(await guardLoginAttempt("staff", "a@demo.local")).toBeNull();
    expect(await guardLoginAttempt("staff", "b@demo.local")).toBeNull();
    expect(await guardLoginAttempt("staff", "c@demo.local")).not.toBeNull();
  });
});
