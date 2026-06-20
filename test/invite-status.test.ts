import { describe, expect, it, vi } from "vitest";
import {
  effectiveInviteStatus,
  expireStalePendingInvites,
  EXPIRE_STALE_INVITES_SQL,
} from "../lib/invite-status";

/**
 * Unit tests for invite lifecycle status resolution (alpha-invite-lifecycle-001).
 * Pure logic — no DB. The sweep test asserts the SQL is issued, not its effect
 * (that's covered by the RLS/integration suite when DATABASE_URL is set).
 */
describe("effectiveInviteStatus", () => {
  const now = new Date("2026-06-20T12:00:00Z");

  it("keeps a pending invite pending before expiry", () => {
    expect(
      effectiveInviteStatus("pending", "2026-06-25T12:00:00Z", now),
    ).toBe("pending");
  });

  it("treats a pending invite past its expiry as expired", () => {
    expect(
      effectiveInviteStatus("pending", "2026-06-19T12:00:00Z", now),
    ).toBe("expired");
  });

  it("treats a pending invite at the exact expiry as expired", () => {
    expect(effectiveInviteStatus("pending", now, now)).toBe("expired");
  });

  it("treats a pending invite with no expiry as still pending", () => {
    expect(effectiveInviteStatus("pending", null, now)).toBe("pending");
  });

  it("returns terminal statuses as-is regardless of expiry", () => {
    // Accepted/revoked must never be reinterpreted by the expiry clock.
    expect(
      effectiveInviteStatus("accepted", "2026-06-19T12:00:00Z", now),
    ).toBe("accepted");
    expect(
      effectiveInviteStatus("revoked", "2026-06-25T12:00:00Z", now),
    ).toBe("revoked");
    expect(
      effectiveInviteStatus("expired", "2026-06-25T12:00:00Z", now),
    ).toBe("expired");
  });

  it("defends against an unknown status by treating it as unusable", () => {
    expect(effectiveInviteStatus("bogus", null, now)).toBe("expired");
  });
});

describe("expireStalePendingInvites", () => {
  it("issues the expiry sweep against the given client", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0 });
    await expireStalePendingInvites({ query });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(EXPIRE_STALE_INVITES_SQL);
  });

  it("only ever targets pending, past-expiry rows", () => {
    // Guard the SQL shape so a future edit can't widen what the sweep touches.
    expect(EXPIRE_STALE_INVITES_SQL).toContain("set status = 'expired'");
    expect(EXPIRE_STALE_INVITES_SQL).toContain("status = 'pending'");
    expect(EXPIRE_STALE_INVITES_SQL).toContain("expires_at <= now()");
  });
});
