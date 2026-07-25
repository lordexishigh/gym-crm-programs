import type Stripe from "stripe";
import { withAdminContext } from "@/lib/db";
import { logger } from "@/lib/observability/logger";
import { captureException } from "@/lib/observability/monitoring";
import { sendPaymentFailedEmail } from "@/lib/notifications";
import { MAX_PAYMENT_RETRIES } from "@/lib/stripe";

/**
 * Stripe webhook event handling (market gap #3): reconciles Checkout/
 * subscription lifecycle events against `member_plans`.
 *
 * Runs via the privileged admin path (`withAdminContext`) — like the Resend
 * delivery-event recorder (lib/email/delivery.ts), an inbound provider
 * callback has no app session, and the event is already authenticated by its
 * verified signature before this is called (see app/api/stripe/webhook). All
 * lookups key off Stripe ids (globally unique), not tenant_id, since the
 * webhook has no session-derived tenant to scope by.
 *
 * "Automated failed-payment retry": Stripe's own Smart Retries (configured in
 * the Stripe Dashboard → Billing → Revenue recovery) re-attempts the charge
 * on its own schedule and re-fires `invoice.payment_failed` on each attempt —
 * this handler is what turns those repeated webhook deliveries into the
 * app-visible `payment_retry_count` / `past_due` state and the member-facing
 * email, and expires the membership after `MAX_PAYMENT_RETRIES`.
 */

export function extractSubscriptionId(invoice: Stripe.Invoice): string | null {
  // Older API shape: invoice.subscription is a string id or expanded object.
  const direct = (
    invoice as unknown as { subscription?: string | { id?: string } | null }
  ).subscription;
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object" && typeof direct.id === "string") {
    return direct.id;
  }

  // Newer API shape (invoices restructured under `parent`).
  const parent = (
    invoice as unknown as {
      parent?: {
        subscription_details?: { subscription?: string | { id?: string } | null } | null;
      } | null;
    }
  ).parent;
  const viaParent = parent?.subscription_details?.subscription;
  if (typeof viaParent === "string") return viaParent;
  if (viaParent && typeof viaParent === "object" && typeof viaParent.id === "string") {
    return viaParent.id;
  }
  return null;
}

export function extractPeriodEnd(invoice: Stripe.Invoice): Date | null {
  const line = invoice.lines?.data?.[0] as unknown as
    | { period?: { end?: number } }
    | undefined;
  const end = line?.period?.end;
  return typeof end === "number" ? new Date(end * 1000) : null;
}

type MemberPlanContact = {
  member_plan_id: string;
  member_id: string;
  status: string;
  payment_retry_count: number;
  member_email: string | null;
  member_full_name: string;
  plan_name: string;
};

async function checkoutSessionCompleted(
  session: Stripe.Checkout.Session,
  eventId: string,
): Promise<void> {
  const memberPlanId =
    session.client_reference_id || (session.metadata?.member_plan_id ?? null);
  if (!memberPlanId) {
    logger.warn("stripe checkout.session.completed with no member_plan_id", {
      sessionId: session.id,
    });
    return;
  }

  const customerId = typeof session.customer === "string" ? session.customer : null;
  const subscriptionId =
    typeof session.subscription === "string" ? session.subscription : null;
  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : null;

  await withAdminContext(async (c) => {
    const { rows } = await c.query<{ member_id: string }>(
      `update member_plans
          set status = 'active',
              stripe_customer_id = coalesce($2, stripe_customer_id),
              stripe_subscription_id = coalesce($3, stripe_subscription_id),
              stripe_payment_intent_id = coalesce($4, stripe_payment_intent_id),
              payment_retry_count = 0,
              updated_at = now()
        where id = $1
        returning member_id`,
      [memberPlanId, customerId, subscriptionId, paymentIntentId],
    );
    const memberId = rows[0]?.member_id;
    if (!memberId) return;

    await c.query(
      `update member set membership_status = 'active', updated_at = now()
        where id = $1`,
      [memberId],
    );

    // Subscription checkouts are followed by their own invoice.payment_succeeded
    // event (recorded there); a one-time (drop-in) checkout has no invoice at
    // all, so THIS is the only event that ever confirms it was paid.
    if (!subscriptionId && typeof session.amount_total === "number") {
      await c.query(
        `insert into payment_events
           (tenant_id, member_id, member_plan_id, amount_cents, currency, status, stripe_event_id)
         select tenant_id, $1, $2, $3, $4, 'succeeded', $5
           from member_plans where id = $2
         on conflict (stripe_event_id) where stripe_event_id is not null do nothing`,
        [
          memberId,
          memberPlanId,
          session.amount_total,
          (session.currency ?? "eur").toUpperCase(),
          eventId,
        ],
      );
    }
  });
}

/** Load the member/plan contact info a subscription-id lookup resolves to. */
async function loadBySubscriptionId(
  subscriptionId: string,
): Promise<MemberPlanContact | null> {
  return withAdminContext(async (c) => {
    const { rows } = await c.query<MemberPlanContact>(
      `select mp.id as member_plan_id, mp.member_id, mp.status, mp.payment_retry_count,
              m.email as member_email, m.full_name as member_full_name,
              p.name as plan_name
         from member_plans mp
         join member m on m.id = mp.member_id
         join membership_plans p on p.id = mp.plan_id
        where mp.stripe_subscription_id = $1`,
      [subscriptionId],
    );
    return rows[0] ?? null;
  });
}

async function invoicePaymentFailed(invoice: Stripe.Invoice, eventId: string): Promise<void> {
  const subscriptionId = extractSubscriptionId(invoice);
  if (!subscriptionId) return; // drop-in (one-time) payments have no invoice/subscription

  const contact = await loadBySubscriptionId(subscriptionId);
  if (!contact) {
    logger.warn("stripe invoice.payment_failed for unknown subscription", {
      subscriptionId,
    });
    return;
  }

  const retryCount = contact.payment_retry_count + 1;
  const expired = retryCount >= MAX_PAYMENT_RETRIES;

  await withAdminContext(async (c) => {
    await c.query(
      `update member_plans
          set status = 'past_due', payment_retry_count = $2, updated_at = now()
        where id = $1`,
      [contact.member_plan_id, retryCount],
    );
    if (expired) {
      await c.query(
        `update member set membership_status = 'expired', updated_at = now()
          where id = $1`,
        [contact.member_id],
      );
    }
    await c.query(
      `insert into payment_events
         (tenant_id, member_id, member_plan_id, amount_cents, currency, status, stripe_event_id)
       select tenant_id, $1, $2, $3, $4, 'failed', $5
         from member_plans where id = $2
       on conflict (stripe_event_id) where stripe_event_id is not null do nothing`,
      [
        contact.member_id,
        contact.member_plan_id,
        invoice.amount_due,
        invoice.currency.toUpperCase(),
        eventId,
      ],
    );
  });

  await captureException(
    new Error(`Payment failed for subscription ${subscriptionId} (attempt ${retryCount})`),
    {
      source: "stripe-payment-failed",
      severity: expired ? "critical" : "warning",
      subscriptionId,
      retryCount,
    },
  );

  if (contact.member_email) {
    await sendPaymentFailedEmail({
      to: contact.member_email,
      memberName: contact.member_full_name,
      planName: contact.plan_name,
      retryCount,
    });
  }
}

async function invoicePaymentSucceeded(invoice: Stripe.Invoice, eventId: string): Promise<void> {
  const subscriptionId = extractSubscriptionId(invoice);
  if (!subscriptionId) return;

  const periodEnd = extractPeriodEnd(invoice);
  const contact = await loadBySubscriptionId(subscriptionId);
  if (!contact) return;

  await withAdminContext(async (c) => {
    await c.query(
      `update member_plans
          set status = 'active', payment_retry_count = 0,
              current_period_end = coalesce($2, current_period_end),
              updated_at = now()
        where id = $1`,
      [contact.member_plan_id, periodEnd],
    );
    await c.query(
      `update member set membership_status = 'active', updated_at = now()
        where id = $1`,
      [contact.member_id],
    );
    await c.query(
      `insert into payment_events
         (tenant_id, member_id, member_plan_id, amount_cents, currency, status, stripe_event_id)
       select tenant_id, $1, $2, $3, $4, 'succeeded', $5
         from member_plans where id = $2
       on conflict (stripe_event_id) where stripe_event_id is not null do nothing`,
      [
        contact.member_id,
        contact.member_plan_id,
        invoice.amount_paid,
        invoice.currency.toUpperCase(),
        eventId,
      ],
    );
  });

  // Renewal reminders are sent by the scheduled expiry script (7 days out),
  // not here — this event just confirms the CURRENT period is paid.
}

async function subscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  await withAdminContext(async (c) => {
    await c.query(
      `update member_plans
          set status = 'cancelled', cancelled_at = now(), updated_at = now()
        where stripe_subscription_id = $1`,
      [subscription.id],
    );
  });
}

/** Dispatch a verified Stripe event to its handler. Unknown types are ignored. */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
      await checkoutSessionCompleted(event.data.object as Stripe.Checkout.Session, event.id);
      return;
    case "invoice.payment_failed":
      await invoicePaymentFailed(event.data.object as Stripe.Invoice, event.id);
      return;
    case "invoice.payment_succeeded":
      await invoicePaymentSucceeded(event.data.object as Stripe.Invoice, event.id);
      return;
    case "customer.subscription.deleted":
      await subscriptionDeleted(event.data.object as Stripe.Subscription);
      return;
    default:
      return;
  }
}
