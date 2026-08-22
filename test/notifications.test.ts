import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sendBookingConfirmationEmail,
  sendMembershipExpiryEmail,
  sendPaymentFailedEmail,
  sendWaitlistPromotionEmail,
  notifyWaitlistPromotions,
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

describe("sendWaitlistPromotionEmail", () => {
  it("tells the member a spot opened up and names the class", async () => {
    const fetchMock = mockFetchOk();
    const ok = await sendWaitlistPromotionEmail({
      to: "member@example.com",
      memberName: "Jane",
      className: "Morning CrossFit",
      startsAt: new Date("2026-01-01T09:00:00Z"),
    });
    expect(ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.to).toEqual(["member@example.com"]);
    expect(body.subject).toMatch(/spot opened up/i);
    expect(body.html).toContain("Morning CrossFit");
    expect(body.text).toContain("moved off the waitlist");
  });

  it("escapes HTML in member-supplied names", async () => {
    const fetchMock = mockFetchOk();
    await sendWaitlistPromotionEmail({
      to: "member@example.com",
      memberName: '<script>alert("x")</script>',
      className: "Yoga",
      startsAt: new Date("2026-01-01T09:00:00Z"),
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.html).not.toContain("<script>");
    expect(body.html).toContain("&lt;script&gt;");
  });

  it("reports failure rather than throwing when the send fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    await expect(
      sendWaitlistPromotionEmail({
        to: "member@example.com",
        memberName: "Jane",
        className: "Class",
        startsAt: new Date("2026-01-01T09:00:00Z"),
      }),
    ).resolves.toBe(false);
  });
});

describe("notifyWaitlistPromotions", () => {
  const promotion = (over: Partial<Parameters<typeof notifyWaitlistPromotions>[0][0]> = {}) => ({
    booking_id: "b1",
    member_id: "m1",
    member_name: "Jane",
    member_email: "jane@example.com",
    class_id: "c1",
    class_name: "Morning CrossFit",
    starts_at: "2026-01-01T09:00:00.000Z",
    ...over,
  });

  it("emails each promoted member and returns their booking ids", async () => {
    const fetchMock = mockFetchOk();
    const result = await notifyWaitlistPromotions([
      promotion(),
      promotion({ booking_id: "b2", member_email: "sam@example.com", member_name: "Sam" }),
    ]);
    expect(result).toEqual({ notified: ["b1", "b2"], emailed: 2, noAddress: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does nothing for an empty batch", async () => {
    const fetchMock = mockFetchOk();
    await expect(notifyWaitlistPromotions([])).resolves.toEqual({
      notified: [],
      emailed: 0,
      noAddress: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A member with no address can never be emailed, so treating them as
  // "unnotified" would leave a row pending a retry that can never succeed.
  //
  // But `notified` and `emailed` must diverge here, and that is the point of the
  // separate counts: a caller that reported `notified.length` as "emailed" would
  // tell staff this member was contacted when no send was even attempted.
  it("marks a member with no email as handled without sending, and does not count it as emailed", async () => {
    const fetchMock = mockFetchOk();
    const result = await notifyWaitlistPromotions([promotion({ member_email: null })]);
    expect(result).toEqual({ notified: ["b1"], emailed: 0, noAddress: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The promotion is already committed in the DB by this point — a mail outage
  // must not bubble up and fail the member's cancellation.
  it("never throws when a send fails, and omits that booking id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    await expect(
      notifyWaitlistPromotions([promotion(), promotion({ booking_id: "b2" })]),
    ).resolves.toEqual({ notified: [], emailed: 0, noAddress: 0 });
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
