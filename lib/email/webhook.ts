import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Resend inbound webhook: signature verification + event parsing
 * (beta-hardening-002).
 *
 * Resend signs webhooks with Svix. Each delivery carries three headers:
 *   svix-id         unique message id
 *   svix-timestamp  unix seconds when the message was sent
 *   svix-signature  space-separated list of `v1,<base64 hmac>` signatures
 *
 * The signed content is `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256
 * with the webhook's signing secret. The secret is provisioned as
 * `whsec_<base64>`; the bytes after the prefix are the actual HMAC key.
 *
 * Both functions are PURE (node:crypto only, no network/DB) so the security-
 * critical verification is unit-testable. The route (app/api/email/webhook)
 * does the I/O and persistence. We NEVER trust an event we can't verify.
 */

export type ResendHeaders = {
  svixId?: string | null;
  svixTimestamp?: string | null;
  svixSignature?: string | null;
};

/** Normalised, app-relevant delivery state derived from a Resend event. */
export type DeliveryStatus =
  | "sent"
  | "delivered"
  | "delayed"
  | "bounced"
  | "complained"
  | "failed";

export type ResendDeliveryEvent = {
  /** The Resend message id, used to correlate back to the invite row. */
  emailId: string;
  /** Recipients the event concerns (lower-cased). */
  to: string[];
  /** Mapped delivery state. */
  status: DeliveryStatus;
  /** Human-readable detail (bounce reason / complaint type), if any. */
  detail?: string;
  /** The raw Resend event type, e.g. "email.bounced". */
  rawType: string;
};

/** Resend event type -> our delivery status. Events we don't track map to null. */
const STATUS_BY_TYPE: Record<string, DeliveryStatus | null> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  // Engagement events carry no deliverability signal — ignored.
  "email.opened": null,
  "email.clicked": null,
};

/** Delivery states that indicate a real deliverability problem (alert-worthy). */
export const NEGATIVE_DELIVERY: ReadonlySet<DeliveryStatus> = new Set<DeliveryStatus>([
  "bounced",
  "complained",
  "failed",
]);

/**
 * Verify the Svix signature on a Resend webhook. `rawBody` MUST be the exact
 * bytes received (re-serialising parsed JSON would change them and break the
 * HMAC). Constant-time comparison; returns false on any missing input or
 * mismatch rather than throwing.
 */
export function verifyResendSignature(
  secret: string | undefined,
  headers: ResendHeaders,
  rawBody: string,
): boolean {
  if (!secret) return false;
  const { svixId, svixTimestamp, svixSignature } = headers;
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  // Secret is `whsec_<base64>`; the HMAC key is the decoded payload after it.
  const secretKey = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(secretKey, "base64");
  } catch {
    return false;
  }

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = createHmac("sha256", key)
    .update(signedContent)
    .digest("base64");
  const expectedBuf = Buffer.from(expected);

  // The header is a space-separated list of `version,signature` pairs; any v1
  // entry matching is sufficient. Compare in constant time.
  for (const part of svixSignature.split(" ")) {
    const comma = part.indexOf(",");
    if (comma === -1) continue;
    const version = part.slice(0, comma);
    const sig = part.slice(comma + 1);
    if (version !== "v1" || !sig) continue;
    const sigBuf = Buffer.from(sig);
    if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) {
      return true;
    }
  }
  return false;
}

/** Pull a printable bounce/complaint detail out of the event's data, if present. */
function extractDetail(data: Record<string, unknown>): string | undefined {
  const bounce = data.bounce;
  if (bounce && typeof bounce === "object") {
    const b = bounce as Record<string, unknown>;
    const parts = [b.type, b.subType, b.message].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    if (parts.length) return parts.join(": ").slice(0, 500);
  }
  if (typeof data.reason === "string" && data.reason) {
    return data.reason.slice(0, 500);
  }
  return undefined;
}

/**
 * Parse a (already signature-verified) Resend event body into a normalised
 * delivery event. Returns null for events we don't track (opens/clicks) or a
 * malformed/unrecognised payload — the caller treats null as "acknowledge and
 * ignore" so Resend doesn't retry a well-formed but irrelevant event.
 */
export function parseResendEvent(body: unknown): ResendDeliveryEvent | null {
  if (!body || typeof body !== "object") return null;
  const evt = body as Record<string, unknown>;
  const rawType = typeof evt.type === "string" ? evt.type : "";
  const status = STATUS_BY_TYPE[rawType];
  if (!status) return null; // unknown or intentionally-ignored event type

  const data =
    evt.data && typeof evt.data === "object"
      ? (evt.data as Record<string, unknown>)
      : {};

  const emailId =
    typeof data.email_id === "string"
      ? data.email_id
      : typeof data.id === "string"
        ? data.id
        : "";
  if (!emailId) return null; // can't correlate without the message id

  const rawTo = data.to;
  const to = (Array.isArray(rawTo) ? rawTo : rawTo ? [rawTo] : [])
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.toLowerCase());

  return { emailId, to, status, detail: extractDetail(data), rawType };
}
