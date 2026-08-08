import { NextResponse } from "next/server";
import { getStripeClient } from "@/lib/stripe";
import { handleStripeEvent } from "@/lib/stripe-events";
import { logger } from "@/lib/observability/logger";
import { captureException } from "@/lib/observability/monitoring";

/**
 * Inbound Stripe webhook (market gap #3): checkout completion + subscription
 * billing lifecycle. Mirrors the structure of app/api/email/webhook — raw
 * body read BEFORE parsing (the signature is computed over the exact bytes),
 * verified before anything is trusted, node runtime (signature verification
 * uses node:crypto under the hood via the Stripe SDK).
 *
 * SECURITY: every event MUST carry a valid `stripe-signature` header verified
 * against STRIPE_WEBHOOK_SECRET. An unsigned/forged event is rejected with
 * 400 — without this, anyone could POST a fake `checkout.session.completed`
 * and grant themselves an active membership for free.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !secret) {
    logger.warn("rejected stripe webhook: missing signature or secret configured", {
      source: "stripe-webhook",
    });
    return new NextResponse(null, { status: 400 });
  }

  const rawBody = await request.text();

  let event;
  try {
    event = getStripeClient().webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    logger.warn("rejected stripe webhook: signature verification failed", {
      source: "stripe-webhook",
      error: err instanceof Error ? err.message : String(err),
    });
    return new NextResponse(null, { status: 400 });
  }

  try {
    await handleStripeEvent(event);
  } catch (err) {
    // A DB failure while reconciling must not make Stripe stop retrying — but
    // it IS a critical signal (a payment event silently failed to apply).
    await captureException(err, {
      source: "stripe-webhook",
      severity: "critical",
      eventType: event.type,
      eventId: event.id,
    });
    return new NextResponse(null, { status: 500 });
  }

  return new NextResponse(null, { status: 200 });
}
