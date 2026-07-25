import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sendBookingConfirmationEmail,
  sendMembershipExpiryEmail,
  sendPaymentFailedEmail,
} from "../lib/notifications";

/**
 * Unit tests for the automated member notifications (market gap #7): booking
 * confirmation, payment failure, membership expiry. `fetch` is mocked (same
 * approach as test/email.test.ts) — asserts each sends the right subject/
 * recipient via the existing Resend wrapper, and never throws on failure
 * (best-effort, per lib/notifications.ts's `sendBestEffort`).
 */
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.INVITE_FROM_EMAIL = "Alpha CRM <noreply@example.eu>";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

function mockFetchOk() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ id: "email_123" }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("sendBookingConfirmationEmail", () => {
  it("sends a confirmation subject when booked", async () => {
    const fetchMock = mockFetchOk();
    await sendBookingConfirmationEmail({
      to: "member@example.com",
      memberName: "Jane",
      className: "Morning CrossFit",
      startsAt: new Date("2026-01-01T09:00:00Z"),
      waitlisted: false,
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.to).toEqual(["member@example.com"]);
    expect(body.subject).toMatch(/Booking confirmed/);
  });

  it("sends a waitlist subject when waitlisted", async () => {
    const fetchMock = mockFetchOk();
    await sendBookingConfirmationEmail({
      to: "member@example.com",
      memberName: "Jane",
      className: "Morning CrossFit",
      startsAt: new Date("2026-01-01T09:00:00Z"),
      waitlisted: true,
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.subject).toMatch(/waitlist/i);
  });

  it("never throws when the send fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    await expect(
      sendBookingConfirmationEmail({
        to: "member@example.com",
        memberName: "Jane",
        className: "Class",
        startsAt: new Date(),
        waitlisted: false,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("sendPaymentFailedEmail", () => {
  it("sends the plan name and retry count", async () => {
    const fetchMock = mockFetchOk();
    await sendPaymentFailedEmail({
      to: "member@example.com",
      memberName: "Jane",
      planName: "Unlimited Monthly",
      retryCount: 2,
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.subject).toMatch(/Payment failed/);
    expect(body.html).toContain("Unlimited Monthly");
    expect(body.text).toContain("Attempt 2 of 3");
  });
});

describe("sendMembershipExpiryEmail", () => {
  it("sends a renewal reminder", async () => {
    const fetchMock = mockFetchOk();
    await sendMembershipExpiryEmail({
      to: "member@example.com",
      memberName: "Jane",
      planName: "Annual",
      expiresAt: new Date("2026-02-01T00:00:00Z"),
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.subject).toMatch(/renews soon/);
  });
});
