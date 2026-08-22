import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseResendEvent,
  verifyResendSignature,
  NEGATIVE_DELIVERY,
} from "../lib/email/webhook";

/**
 * Unit tests for the Resend inbound-webhook helpers (beta-hardening-002).
 * Pure (node:crypto only) — no network/DB. Cover the security-critical Svix
 * signature verification and the event -> delivery-status mapping, including
 * the failure paths (forged/missing signatures, ignored event types).
 */

// Build a valid Svix signature the way Resend does, for a given secret.
function sign(secret: string, id: string, ts: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return `v1,${sig}`;
}

const SECRET = "whsec_" + Buffer.from("super-secret-signing-key").toString("base64");

describe("verifyResendSignature", () => {
  const id = "msg_123";
  const ts = "1700000000";
  // The clock the signature is verified against. Passed explicitly so these
  // assertions do not depend on when the suite runs — without it, every fixture
  // below would fall outside the replay window and the whole block would fail
  // for a reason unrelated to what it is testing.
  const NOW_MS = 1_700_000_000_000;
  const body = JSON.stringify({ type: "email.bounced" });

  it("accepts a correctly-signed payload", () => {
    const ok = verifyResendSignature(
      SECRET,
      { svixId: id, svixTimestamp: ts, svixSignature: sign(SECRET, id, ts, body) },
      body,
      NOW_MS,
    );
    expect(ok).toBe(true);
  });

  it("accepts when one of several space-separated signatures matches", () => {
    const good = sign(SECRET, id, ts, body);
    const sig = `v1,AAAA ${good}`;
    expect(
      verifyResendSignature(SECRET, { svixId: id, svixTimestamp: ts, svixSignature: sig }, body, NOW_MS),
    ).toBe(true);
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const sig = sign(SECRET, id, ts, body);
    const ok = verifyResendSignature(
      SECRET,
      { svixId: id, svixTimestamp: ts, svixSignature: sig },
      body + "tampered",
      NOW_MS,
    );
    expect(ok).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const other = "whsec_" + Buffer.from("different-key").toString("base64");
    const sig = sign(other, id, ts, body);
    expect(
      verifyResendSignature(SECRET, { svixId: id, svixTimestamp: ts, svixSignature: sig }, body, NOW_MS),
    ).toBe(false);
  });

  it("rejects when the secret is unset", () => {
    expect(
      verifyResendSignature(undefined, { svixId: id, svixTimestamp: ts, svixSignature: "v1,x" }, body, NOW_MS),
    ).toBe(false);
  });

  it("rejects when signature headers are missing", () => {
    expect(verifyResendSignature(SECRET, { svixId: id, svixTimestamp: ts, svixSignature: null }, body, NOW_MS)).toBe(false);
    expect(verifyResendSignature(SECRET, { svixId: null, svixTimestamp: ts, svixSignature: "v1,x" }, body, NOW_MS)).toBe(false);
  });

  /**
   * Replay window. A valid HMAC proves origin, not freshness — so a captured
   * event stays verifiable forever without this bound, and replaying a `bounced`
   * one re-raises its critical alert every time.
   *
   * The signature in each case below is genuinely VALID; only the clock differs.
   * That is the point: these fail for staleness alone.
   */
  it("rejects a correctly-signed event that is older than the tolerance", () => {
    const sig = sign(SECRET, id, ts, body);
    const sixMinutesLater = NOW_MS + 6 * 60 * 1000;
    expect(
      verifyResendSignature(SECRET, { svixId: id, svixTimestamp: ts, svixSignature: sig }, body, sixMinutesLater),
    ).toBe(false);
  });

  // Symmetric: a timestamp well ahead of our clock is a forgery signal too, and
  // would otherwise buy an attacker an arbitrarily long replay window.
  it("rejects a correctly-signed event dated too far in the future", () => {
    const sig = sign(SECRET, id, ts, body);
    const sixMinutesEarlier = NOW_MS - 6 * 60 * 1000;
    expect(
      verifyResendSignature(SECRET, { svixId: id, svixTimestamp: ts, svixSignature: sig }, body, sixMinutesEarlier),
    ).toBe(false);
  });

  it("accepts an event just inside the tolerance", () => {
    const sig = sign(SECRET, id, ts, body);
    const fourMinutesLater = NOW_MS + 4 * 60 * 1000;
    expect(
      verifyResendSignature(SECRET, { svixId: id, svixTimestamp: ts, svixSignature: sig }, body, fourMinutesLater),
    ).toBe(true);
  });

  it("rejects a non-numeric timestamp rather than treating it as epoch", () => {
    const sig = sign(SECRET, id, "not-a-number", body);
    expect(
      verifyResendSignature(
        SECRET,
        { svixId: id, svixTimestamp: "not-a-number", svixSignature: sig },
        body,
        NOW_MS,
      ),
    ).toBe(false);
  });
});

describe("parseResendEvent", () => {
  it("maps a bounce to status 'bounced' with the reason as detail", () => {
    const evt = parseResendEvent({
      type: "email.bounced",
      data: {
        email_id: "email_abc",
        to: ["Member@Example.com"],
        bounce: { type: "Permanent", subType: "General", message: "mailbox does not exist" },
      },
    });
    expect(evt).not.toBeNull();
    expect(evt!.status).toBe("bounced");
    expect(evt!.emailId).toBe("email_abc");
    expect(evt!.to).toEqual(["member@example.com"]); // lower-cased
    expect(evt!.detail).toContain("mailbox does not exist");
    expect(NEGATIVE_DELIVERY.has(evt!.status)).toBe(true);
  });

  it("maps delivered / complained / sent", () => {
    expect(parseResendEvent({ type: "email.delivered", data: { email_id: "e" } })!.status).toBe("delivered");
    expect(parseResendEvent({ type: "email.complained", data: { email_id: "e" } })!.status).toBe("complained");
    expect(parseResendEvent({ type: "email.sent", data: { email_id: "e" } })!.status).toBe("sent");
  });

  it("ignores engagement events (open/click)", () => {
    expect(parseResendEvent({ type: "email.opened", data: { email_id: "e" } })).toBeNull();
    expect(parseResendEvent({ type: "email.clicked", data: { email_id: "e" } })).toBeNull();
  });

  it("returns null without a usable email id or for unknown types", () => {
    expect(parseResendEvent({ type: "email.bounced", data: {} })).toBeNull();
    expect(parseResendEvent({ type: "something.else", data: { email_id: "e" } })).toBeNull();
    expect(parseResendEvent(null)).toBeNull();
    expect(parseResendEvent("nope")).toBeNull();
  });
});
