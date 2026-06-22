import { NextResponse } from "next/server";
import {
  parseResendEvent,
  verifyResendSignature,
} from "@/lib/email/webhook";
import { recordDeliveryEvent } from "@/lib/email/delivery";
import { logger } from "@/lib/observability/logger";

/**
 * Inbound Resend webhook (beta-hardening-002).
 *
 * Receives delivery lifecycle events (sent/delivered/bounced/complained/...)
 * for invite emails and surfaces them via the invite row + monitoring. Mirrors
 * the structure of app/api/observability/report:
 *   - force-dynamic (never cached),
 *   - reads the body defensively,
 *   - never echoes anything sensitive back.
 *
 * SECURITY: every event MUST carry a valid Svix signature computed over the
 * RAW request body with RESEND_WEBHOOK_SECRET. An unsigned/forged event is
 * rejected with 401 so a third party cannot spoof bounces (which would let them
 * suppress a victim's invites). Register the secret in the Resend dashboard
 * when adding this endpoint as a webhook (see docs/DEPLOYMENT.md).
 *
 * Node runtime: the signature verification uses node:crypto.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  // Read the EXACT bytes — the signature is computed over the raw body, so we
  // must verify before parsing (re-serialising JSON would change the bytes).
  const rawBody = await request.text();

  const ok = verifyResendSignature(
    process.env.RESEND_WEBHOOK_SECRET,
    {
      svixId: request.headers.get("svix-id"),
      svixTimestamp: request.headers.get("svix-timestamp"),
      svixSignature: request.headers.get("svix-signature"),
    },
    rawBody,
  );
  if (!ok) {
    logger.warn("rejected unsigned/invalid Resend webhook", {
      source: "resend-webhook",
    });
    return new NextResponse(null, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // Signed but unparseable — acknowledge so Resend doesn't retry forever.
    return new NextResponse(null, { status: 204 });
  }

  const event = parseResendEvent(body);
  if (!event) {
    // Verified but an event type we don't track (open/click) or no message id.
    return new NextResponse(null, { status: 204 });
  }

  await recordDeliveryEvent(event);

  // Always 200 a handled event so Resend marks it delivered (recordDeliveryEvent
  // is best-effort and never throws).
  return new NextResponse(null, { status: 200 });
}
