import { describe, expect, it } from "vitest";
import {
  generateInviteToken,
  hashInviteToken,
  isInviteExpired,
  inviteAcceptUrl,
} from "../lib/invites";

/**
 * Unit tests for invite token generation/verification (mvp-member-management-003/004).
 * Pure (node:crypto only) — no DB. Asserts the security-relevant properties:
 * tokens are unique, the stored value is a hash (not the token), and expiry is
 * correct.
 */
describe("invite tokens", () => {
  it("generates a token and a matching sha256 hash", () => {
    const { token, tokenHash } = generateInviteToken();
    expect(token.length).toBeGreaterThan(20);
    expect(tokenHash).toHaveLength(64); // sha256 hex
    expect(tokenHash).toBe(hashInviteToken(token));
    // The stored hash must NOT equal the raw token.
    expect(tokenHash).not.toBe(token);
  });

  it("produces unique tokens across calls", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  it("hashing is deterministic", () => {
    expect(hashInviteToken("abc")).toBe(hashInviteToken("abc"));
  });

  it("uses URL-safe characters (base64url)", () => {
    const { token } = generateInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("isInviteExpired", () => {
  const now = new Date("2026-06-20T12:00:00Z");

  it("is not expired before the expiry", () => {
    expect(isInviteExpired(new Date("2026-06-25T12:00:00Z"), now)).toBe(false);
  });

  it("is expired at/after the expiry", () => {
    expect(isInviteExpired(new Date("2026-06-19T12:00:00Z"), now)).toBe(true);
    expect(isInviteExpired(now, now)).toBe(true);
  });

  it("accepts an ISO string expiry", () => {
    expect(isInviteExpired("2026-06-19T12:00:00Z", now)).toBe(true);
  });

  it("treats a null expiry as never-expiring", () => {
    expect(isInviteExpired(null, now)).toBe(false);
  });
});

describe("inviteAcceptUrl", () => {
  it("builds an absolute link with the token query param", () => {
    process.env.APP_BASE_URL = "https://app.example.eu";
    const url = inviteAcceptUrl("tok en+/=");
    expect(url).toBe(
      "https://app.example.eu/invite/accept?token=tok%20en%2B%2F%3D",
    );
  });

  it("strips a trailing slash on the base", () => {
    process.env.APP_BASE_URL = "https://app.example.eu/";
    expect(inviteAcceptUrl("x")).toBe(
      "https://app.example.eu/invite/accept?token=x",
    );
  });
});
