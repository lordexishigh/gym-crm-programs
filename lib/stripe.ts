import Stripe from "stripe";

/**
 * Stripe integration (market gap #3): checkout session creation for a
 * member's plan, and shared helpers the webhook route
 * (app/api/stripe/webhook/route.ts) uses to correlate events back to
 * `member_plans` rows.
 *
 * Prices are built ad hoc from the gym's own `membership_plans` row via
 * Checkout's `price_data` rather than requiring the owner to keep a mirrored
 * set of Stripe Products/Prices in sync — the price the gym configures in
 * Alpha CRM IS the price Stripe charges. Checkout Sessions support ad hoc
 * `price_data` (including `recurring`) for subscription mode, so no
 * pre-provisioning step is needed.
 */

let stripeClient: Stripe | null = null;

/** Lazily-created singleton Stripe client. Reads `STRIPE_SECRET_KEY` on first use. */
export function getStripeClient(): Stripe {
  if (!stripeClient) {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new Error("STRIPE_SECRET_KEY is not set (see .env.example).");
    }
    stripeClient = new Stripe(secretKey);
  }
  return stripeClient;
}

/** Maps a plan tier to a Stripe Checkout mode + (when applicable) recurring interval. */
function checkoutModeFor(tier: "monthly" | "annual" | "drop_in"): {
  mode: Stripe.Checkout.SessionCreateParams.Mode;
  recurring?: { interval: "month" | "year" };
} {
  if (tier === "monthly") return { mode: "subscription", recurring: { interval: "month" } };
  if (tier === "annual") return { mode: "subscription", recurring: { interval: "year" } };
  return { mode: "payment" };
}

export type CreateCheckoutSessionParams = {
  memberPlanId: string;
  planName: string;
  tier: "monthly" | "annual" | "drop_in";
  priceCents: number;
  currency: string;
  memberEmail: string;
  tenantId: string;
  memberId: string;
  /** Absolute URLs to return to after checkout completes/cancels. */
  successUrl: string;
  cancelUrl: string;
};

/**
 * Create a Stripe Checkout Session for a single member_plans row. The row id
 * is passed as `client_reference_id` AND in `metadata` (belt-and-suspenders —
 * different webhook events surface it in different places) so the webhook can
 * update the correct subscription without needing a live app session.
 */
export async function createCheckoutSession(
  params: CreateCheckoutSessionParams,
): Promise<Stripe.Checkout.Session> {
  const stripe = getStripeClient();
  const { mode, recurring } = checkoutModeFor(params.tier);

  return stripe.checkout.sessions.create({
    mode,
    customer_email: params.memberEmail,
    client_reference_id: params.memberPlanId,
    metadata: {
      tenant_id: params.tenantId,
      member_id: params.memberId,
      member_plan_id: params.memberPlanId,
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: params.currency.toLowerCase(),
          unit_amount: params.priceCents,
          product_data: { name: params.planName },
          ...(recurring ? { recurring } : {}),
        },
      },
    ],
    subscription_data:
      mode === "subscription"
        ? { metadata: { tenant_id: params.tenantId, member_plan_id: params.memberPlanId } }
        : undefined,
    payment_intent_data:
      mode === "payment"
        ? { metadata: { tenant_id: params.tenantId, member_plan_id: params.memberPlanId } }
        : undefined,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
  });
}

/** How many consecutive failed-payment retries before we flag the membership as expired. */
export const MAX_PAYMENT_RETRIES = 3;
