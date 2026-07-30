import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sign-in brute-force policy (beta-hardening-002).
 *
 * `lib/rate-limit` proves the counter is correct; this proves the POLICY wired on
 * top of it is the one we want on `/login` and `/portal/login`, which until now
 * accepted unlimited password attempts:
 *
 *   - a single host is cut off after `LOGIN_THROTTLE_IP_ATTEMPTS` tries,
 *   - one account is cut off across many hosts (credential stuffing),
 *   - staff and member surfaces have separate budgets,
 *   - the refusal message never reveals which bucket tripped (that would confirm
 *     an address is registered), and
 *   - a successful sign-in wipes the penalty.
 *
 * `next/headers` is mocked because `headers()` only works inside a request scope.
 * The mock is the seam an attacker would push on anyway — the client IP.
 */

/** Swapped per test to simulate requests from different hosts. */
let requestHeaders = new Headers();

vi.mock("next/headers", () => ({
  headers: async () => requestHeaders,
}));

function fromIp(ip: string) {
  // The platform-set header, i.e. the one a client cannot forge.
  requestHeaders = new Headers({ "x-real-ip": ip });
}

async function loadThrottle() {
  const mod = await import("@/lib/auth/login-throttle");
  mod.resetLoginThrottle();
  return mod;
}

describe("guardLoginAttempt", () => {
  beforeEach(() => {
    vi.resetModules();
    requestHeaders = new Headers();
    process.env.LOGIN_THROTTLE_IP_ATTEMPTS = "3";
    process.env.LOGIN_THROTTLE_ACCOUNT_ATTEMPTS = "2";
    process.env.LOGIN_THROTTLE_WINDOW_MS = "60000";
    // The throttle logs a structured warning; keep it out of the test output.
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.LOGIN_THROTTLE_IP_ATTEMPTS;
    delete process.env.LOGIN_THROTTLE_ACCOUNT_ATTEMPTS;
    delete process.env.LOGIN_THROTTLE_WINDOW_MS;
    vi.restoreAllMocks();
  });

  it("permits attempts up to the limit, then refuses with a wait time", async () => {
    const { guardLoginAttempt } = await loadThrottle();
    fromIp("203.0.113.1");

    // Account limit is 2, so it binds first here.
    expect(await guardLoginAttempt("staff", "a@b.test")).toBeNull();
    expect(await guardLoginAttempt("staff", "a@b.test")).toBeNull();

    const blocked = await guardLoginAttempt("staff", "a@b.test");
    expect(blocked).not.toBeNull();
    expect(blocked?.error).toMatch(/too many sign-in attempts/i);
    // Actionable: tells the user when to come back.
    expect(blocked?.error).toMatch(/\d+ (second|minute)s?/);
  });

  it("cuts off one host walking a password list across many accounts", async () => {
    const { guardLoginAttempt } = await loadThrottle();
    fromIp("198.51.100.5");

    // Different address every time, so the per-account bucket never fills — only
    // the per-IP bucket (limit 3) can stop this.
    expect(await guardLoginAttempt("staff", "one@b.test")).toBeNull();
    expect(await guardLoginAttempt("staff", "two@b.test")).toBeNull();
    expect(await guardLoginAttempt("staff", "three@b.test")).toBeNull();
    expect(await guardLoginAttempt("staff", "four@b.test")).not.toBeNull();
  });

  it("cuts off credential stuffing of ONE account from many hosts", async () => {
    const { guardLoginAttempt } = await loadThrottle();

    // A fresh IP each time defeats the per-IP bucket entirely; the per-account
    // bucket (limit 2) is the only thing that sees this pattern.
    fromIp("203.0.113.10");
    expect(await guardLoginAttempt("member", "victim@b.test")).toBeNull();
    fromIp("203.0.113.11");
    expect(await guardLoginAttempt("member", "victim@b.test")).toBeNull();
    fromIp("203.0.113.12");
    expect(await guardLoginAttempt("member", "victim@b.test")).not.toBeNull();
  });

  it("does not leak whether an address is registered", async () => {
    const { guardLoginAttempt } = await loadThrottle();
    fromIp("203.0.113.20");

    await guardLoginAttempt("staff", "a@b.test");
    await guardLoginAttempt("staff", "a@b.test");
    const accountBlocked = await guardLoginAttempt("staff", "a@b.test");

    // Same wording regardless of which bucket tripped, and no mention of
    // "account", "email" or "address" that would confirm the address exists.
    expect(accountBlocked?.error).not.toMatch(/account|email|address|user/i);
  });

  it("treats an address case-insensitively — varying case is not a fresh budget", async () => {
    const { guardLoginAttempt } = await loadThrottle();
    fromIp("203.0.113.30");

    expect(await guardLoginAttempt("staff", "Case@B.test")).toBeNull();
    expect(await guardLoginAttempt("staff", "case@b.test")).toBeNull();
    expect(await guardLoginAttempt("staff", " CASE@b.TEST ")).not.toBeNull();
  });

  it("keeps staff and member budgets separate", async () => {
    const { guardLoginAttempt } = await loadThrottle();
    fromIp("203.0.113.40");

    // Exhaust the staff IP bucket (limit 3).
    await guardLoginAttempt("staff", "a@b.test");
    await guardLoginAttempt("staff", "b@b.test");
    await guardLoginAttempt("staff", "c@b.test");
    expect(await guardLoginAttempt("staff", "d@b.test")).not.toBeNull();

    // A spray at the dashboard must not lock members out of the portal.
    expect(await guardLoginAttempt("member", "a@b.test")).toBeNull();
  });

  it("meters requests with no IP header instead of waving them through", async () => {
    const { guardLoginAttempt } = await loadThrottle();
    requestHeaders = new Headers(); // no proxy headers at all

    // An unauthenticated endpoint must not become unmetered just because a
    // header is missing — that is the state an attacker would try to induce.
    expect(await guardLoginAttempt("staff", "a@b.test")).toBeNull();
    expect(await guardLoginAttempt("staff", "b@b.test")).toBeNull();
    expect(await guardLoginAttempt("staff", "c@b.test")).toBeNull();
    expect(await guardLoginAttempt("staff", "d@b.test")).not.toBeNull();
  });

  it("cannot be bypassed by forging x-forwarded-for", async () => {
    const { guardLoginAttempt } = await loadThrottle();

    // The platform header stays constant (the proxy writes it); the client varies
    // the one header it controls. The budget must still be spent.
    for (let i = 0; i < 3; i += 1) {
      requestHeaders = new Headers({
        "x-real-ip": "203.0.113.50",
        "x-forwarded-for": `10.0.0.${i}`,
      });
      expect(await guardLoginAttempt("staff", `u${i}@b.test`)).toBeNull();
    }
    requestHeaders = new Headers({
      "x-real-ip": "203.0.113.50",
      "x-forwarded-for": "10.0.0.99",
    });
    expect(await guardLoginAttempt("staff", "u99@b.test")).not.toBeNull();
  });

  it("does not charge the account bucket once the IP bucket is exhausted", async () => {
    const { guardLoginAttempt } = await loadThrottle();

    // One host burns its IP budget (limit 3) naming a victim's address, then
    // keeps going. Those extra attempts must not accumulate against the victim,
    // or a single attacker could lock out arbitrary accounts at will.
    fromIp("198.51.100.99");
    await guardLoginAttempt("member", "x@b.test");
    await guardLoginAttempt("member", "y@b.test");
    await guardLoginAttempt("member", "z@b.test");
    for (let i = 0; i < 20; i += 1) {
      expect(await guardLoginAttempt("member", "victim@b.test")).not.toBeNull();
    }

    // The victim, from their own host, still has their full budget.
    fromIp("203.0.113.60");
    expect(await guardLoginAttempt("member", "victim@b.test")).toBeNull();
    expect(await guardLoginAttempt("member", "victim@b.test")).toBeNull();
  });

  it("ignores a junk env override rather than disabling the guard", async () => {
    process.env.LOGIN_THROTTLE_IP_ATTEMPTS = "not-a-number";
    process.env.LOGIN_THROTTLE_ACCOUNT_ATTEMPTS = "-1";
    const { guardLoginAttempt } = await loadThrottle();
    fromIp("203.0.113.70");

    // Falls back to the built-in defaults (IP 10 / account 6), so a typo in the
    // environment cannot silently mean "unlimited".
    for (let i = 0; i < 6; i += 1) {
      expect(await guardLoginAttempt("staff", "a@b.test")).toBeNull();
    }
    expect(await guardLoginAttempt("staff", "a@b.test")).not.toBeNull();
  });
});

describe("clearLoginThrottle", () => {
  beforeEach(() => {
    vi.resetModules();
    requestHeaders = new Headers();
    process.env.LOGIN_THROTTLE_IP_ATTEMPTS = "3";
    process.env.LOGIN_THROTTLE_ACCOUNT_ATTEMPTS = "2";
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.LOGIN_THROTTLE_IP_ATTEMPTS;
    delete process.env.LOGIN_THROTTLE_ACCOUNT_ATTEMPTS;
    vi.restoreAllMocks();
  });

  it("erases the penalty after a successful sign-in", async () => {
    const { guardLoginAttempt, clearLoginThrottle } = await loadThrottle();
    fromIp("203.0.113.80");

    // Two typos, then the right password.
    await guardLoginAttempt("member", "m@b.test");
    await guardLoginAttempt("member", "m@b.test");
    await clearLoginThrottle("member", "m@b.test");

    // The next sign-in (a new session later) starts clean rather than being
    // refused because of earlier typos.
    expect(await guardLoginAttempt("member", "m@b.test")).toBeNull();
    expect(await guardLoginAttempt("member", "m@b.test")).toBeNull();
  });

  it("clears the same bucket the guard charged, regardless of address case", async () => {
    const { guardLoginAttempt, clearLoginThrottle } = await loadThrottle();
    fromIp("203.0.113.81");

    await guardLoginAttempt("member", "Mixed@B.test");
    await guardLoginAttempt("member", "Mixed@B.test");
    await clearLoginThrottle("member", "mixed@b.test");

    expect(await guardLoginAttempt("member", "MIXED@B.TEST")).toBeNull();
  });
});
