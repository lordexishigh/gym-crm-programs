import { withAdminContext } from "@/lib/db";
import { logger } from "@/lib/observability/logger";
import { captureException } from "@/lib/observability/monitoring";
import {
  NEGATIVE_DELIVERY,
  type ResendDeliveryEvent,
} from "@/lib/email/webhook";

/**
 * Persist an inbound Resend delivery event against the invite it concerns and
 * raise the right observability signal (beta-hardening-002).
 *
 * Runs via the privileged admin path: an inbound provider callback has no user
 * session, and the event is already authenticated by its verified Svix
 * signature (see app/api/email/webhook). Correlation is by the Resend message
 * id we stored on the invite at send time.
 *
 * Terminal-failure precedence: once an invite is `bounced`/`complained`/
 * `failed`, a later benign event (a delayed `delivered`, say) must NOT silently
 * clear that — the WHERE guard refuses to overwrite a negative state with a
 * positive one, so staff keep seeing the problem.
 */

const POSITIVE_STATUSES = ["sent", "delivered", "delayed"];

/**
 * Positive states that precede delivery, and so must never replace a recorded
 * `delivered`.
 *
 * Webhook events are not ordered. A `sent` event delayed behind its own
 * `delivered` would otherwise walk the invite backwards to "sent" — showing
 * staff an in-flight message that actually landed, which is the same class of
 * lie as the negative-precedence guard below exists to prevent, just in the
 * other direction.
 */
const PRE_DELIVERY_STATUSES = ["sent", "delayed"];

export type RecordResult = {
  /** Whether an invite row was matched and updated. */
  matched: boolean;
};

export async function recordDeliveryEvent(
  event: ResendDeliveryEvent,
): Promise<RecordResult> {
  const isNegative = NEGATIVE_DELIVERY.has(event.status);

  let matched = false;
  try {
    matched = await withAdminContext(async (c) => {
      const res = await c.query(
        `update invite
            set delivery_status     = $2,
                delivery_detail     = $3,
                delivery_updated_at = now()
          where resend_message_id = $1
            -- Don't let a positive event overwrite a recorded failure.
            and not (delivery_status = any($4) and $2 = any($5))
            -- Don't let a late pre-delivery event walk 'delivered' backwards.
            and not (delivery_status = 'delivered' and $2 = any($6))`,
        [
          event.emailId,
          event.status,
          event.detail ?? null,
          // Derived, not restated: a status added to NEGATIVE_DELIVERY must gain
          // this guard automatically. Listing the three literally meant a new
          // terminal state would be alert-worthy (via `isNegative`) yet still
          // silently overwritable by a later `delivered`.
          [...NEGATIVE_DELIVERY],
          POSITIVE_STATUSES,
          PRE_DELIVERY_STATUSES,
        ],
      );
      return (res.rowCount ?? 0) > 0;
    });
  } catch (err) {
    // A DB failure while recording must not 500 the webhook (Resend would retry
    // indefinitely). Capture it and report no match so the route still 200s.
    await captureException(err, {
      source: "email-delivery-record",
      severity: "error",
      emailId: event.emailId,
      deliveryStatus: event.status,
    });
    return { matched: false };
  }

  if (isNegative) {
    // A bounce or spam complaint is a deliverability problem worth alerting on:
    // at scale these threaten the sending domain's reputation.
    await captureException(
      new Error(`Invite email ${event.status}: ${event.detail ?? "no detail"}`),
      {
        source: "resend-webhook",
        severity: "critical",
        emailId: event.emailId,
        recipients: event.to,
        deliveryStatus: event.status,
        matchedInvite: matched,
      },
    );
  } else {
    logger.info("invite delivery event", {
      emailId: event.emailId,
      deliveryStatus: event.status,
      rawType: event.rawType,
      matchedInvite: matched,
    });
  }

  return { matched };
}
