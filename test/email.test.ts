import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "../lib/email/resend";

/**
 * Unit tests for the Resend send helper (mvp-member-management-002).
 * `fetch` is mocked — no real network. Asserts: it posts with env credentials,
 * returns the provider id on success, and turns failures into a handled error
 * value (never throws).
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

describe("sendEmail", () => {
  it("posts to Resend with auth + from and returns the id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "email_123" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await sendEmail({
      to: "member@example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });

    expect(res).toEqual({ ok: true, id: "email_123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.Authorization).toBe("Bearer re_test_key");
    const body = JSON.parse(init.body);
    expect(body.from).toBe("Alpha CRM <noreply@example.eu>");
    expect(body.to).toEqual(["member@example.com"]);
  });

  it("returns ok:false (no throw) when the provider returns an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ message: "Invalid `to` field" }),
      }),
    );
    const res = await sendEmail({ to: "x", subject: "s", html: "h" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Invalid/);
  });

  it("returns ok:false when fetch throws (network failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const res = await sendEmail({ to: "x", subject: "s", html: "h" });
    expect(res).toEqual({
      ok: false,
      reason: "unreachable",
      error: "Could not reach the email service.",
    });
  });

  it("returns ok:false when credentials are missing", async () => {
    delete process.env.RESEND_API_KEY;
    const res = await sendEmail({ to: "x", subject: "s", html: "h" });
    expect(res.ok).toBe(false);
  });

  /**
   * The reason code is what lets `sendInviteAction` keep an invite alive and
   * fall back to a copyable link when this deployment simply has no mail
   * provider — as opposed to escalating a genuine provider failure. Pinned
   * because collapsing these back into one opaque error is what previously made
   * onboarding impossible without email.
   */
  it("reports a missing provider as not_configured, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.RESEND_API_KEY;

    const res = await sendEmail({ to: "x", subject: "s", html: "h" });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("not_configured");
      expect(res.error).toMatch(/RESEND_API_KEY/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a blank-but-present credential as unconfigured", async () => {
    process.env.RESEND_API_KEY = "   ";
    const res = await sendEmail({ to: "x", subject: "s", html: "h" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
  });

  it("reports a provider rejection as rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ message: "Invalid `to` field" }),
      }),
    );
    const res = await sendEmail({ to: "x", subject: "s", html: "h" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("rejected");
  });
});

describe("isEmailConfigured", () => {
  it("is true only when both credentials are present and non-blank", async () => {
    const { isEmailConfigured } = await import("../lib/email/resend");

    expect(isEmailConfigured()).toBe(true);

    delete process.env.INVITE_FROM_EMAIL;
    expect(isEmailConfigured()).toBe(false);

    process.env.INVITE_FROM_EMAIL = "  ";
    expect(isEmailConfigured()).toBe(false);
  });
});
