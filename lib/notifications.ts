import { sendEmail } from "@/lib/email/resend";
import { captureException } from "@/lib/observability/monitoring";
// Type-only: erased at compile time, so importing it does NOT pull lib/db (pg)
// into anything that imports this module.
import type { PromotedBooking } from "@/lib/classes";

/**
 * Automated member-facing email notifications (market gap #7): booking
 * confirmation, payment failure, and membership-expiry reminders. Built on
 * the existing Resend wrapper (`lib/email/resend.ts`) — same "never throw,
 * return a result" shape as the invite email in
 * app/dashboard/members/actions.ts, so a notification failure never crashes
 * the caller (a webhook handler, a booking action, or a scheduled script).
 * A send failure is reported to observability rather than surfaced to the
 * member — these are best-effort reminders, not the primary transaction.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Sends and reports failure instead of throwing. Returns whether it landed. */
async function sendBestEffort(
  message: Parameters<typeof sendEmail>[0],
  source: string,
  context: Record<string, unknown>,
): Promise<boolean> {
  const result = await sendEmail(message);
  if (!result.ok) {
    await captureException(new Error(`${source} email failed: ${result.error}`), {
      source,
      severity: "warning",
      ...context,
    });
    return false;
  }
  return true;
}

export async function sendBookingConfirmationEmail(params: {
  to: string;
  memberName: string;
  className: string;
  startsAt: Date;
  waitlisted: boolean;
}): Promise<void> {
  const { to, memberName, className, startsAt, waitlisted } = params;
  const when = startsAt.toLocaleString("en-GB", {
    dateStyle: "full",
    timeStyle: "short",
  });
  const safeName = escapeHtml(memberName);
  const safeClass = escapeHtml(className);
  const subject = waitlisted
    ? `You're on the waitlist for ${className}`
    : `Booking confirmed: ${className}`;
  const headline = waitlisted
    ? `You're on the waitlist for <strong>${safeClass}</strong> on ${when}. We'll email you if a spot opens up.`
    : `Your spot in <strong>${safeClass}</strong> on ${when} is confirmed.`;

  await sendBestEffort(
    {
      to,
      subject,
      html: `<!doctype html><html><body style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#0f172a;line-height:1.5">
        <p>Hi ${safeName},</p>
        <p>${headline}</p>
      </body></html>`,
      text: `Hi ${memberName},\n\n${waitlisted ? "You're on the waitlist for" : "Your spot in"} ${className} on ${when}${waitlisted ? ". We'll email you if a spot opens up." : " is confirmed."}`,
    },
    "booking-confirmation-email",
    { to, className },
  );
}

/**
 * The email that makes the waitlist mean something: a spot opened up and the
 * member now holds it. This is the other half of the promise
 * `sendBookingConfirmationEmail` makes when it waitlists someone ("We'll email
 * you if a spot opens up") — without it, auto-promotion happens invisibly and
 * the member turns up expecting to still be waiting, or doesn't turn up at all.
 *
 * Returns whether the send landed, so the caller can record it and avoid
 * emailing the same promotion twice.
 */
export async function sendWaitlistPromotionEmail(params: {
  to: string;
  memberName: string;
  className: string;
  startsAt: Date;
}): Promise<boolean> {
  const { to, memberName, className, startsAt } = params;
  const when = startsAt.toLocaleString("en-GB", {
    dateStyle: "full",
    timeStyle: "short",
  });
  const safeName = escapeHtml(memberName);
  const safeClass = escapeHtml(className);

  return sendBestEffort(
    {
      to,
      subject: `A spot opened up — you're in for ${className}`,
      html: `<!doctype html><html><body style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#0f172a;line-height:1.5">
        <p>Hi ${safeName},</p>
        <p>Good news — a spot opened up and you've been moved off the waitlist. Your place in <strong>${safeClass}</strong> on ${when} is now confirmed.</p>
        <p>If you can no longer make it, please cancel in the member portal so someone else on the waitlist can take it.</p>
      </body></html>`,
      text: `Hi ${memberName},\n\nGood news — a spot opened up and you've been moved off the waitlist. Your place in ${className} on ${when} is now confirmed.\n\nIf you can no longer make it, please cancel in the member portal so someone else on the waitlist can take it.`,
    },
    "waitlist-promotion-email",
    { to, className },
  );
}

/**
 * Outcome of notifying a batch of promotions.
 *
 * `notified` and `emailed` are deliberately NOT the same number, and conflating
 * them is what made the staff-facing "…and emailed" message a lie. `notified`
 * answers "which rows must never be retried", which includes members who have
 * no address and so can never be emailed at all. `emailed` answers "how many
 * people actually heard from us", which is the only figure a caller may repeat
 * back to a human.
 */
export type PromotionNotifyResult = {
  /** Booking ids to mark done: emailed, or with no address to email. */
  notified: string[];
  /** Members who actually received an email. */
  emailed: number;
  /** Members with no address on file — nothing was attempted. */
  noAddress: number;
};

/**
 * Email every member in a batch of fresh waitlist promotions and report what
 * actually happened — the caller passes `notified` to `markPromotionNotified`
 * (lib/classes.ts) so a retry never double-sends.
 *
 * Members with no email on file are counted in `notified` rather than treated as
 * failures: the promotion itself still stands and shows in the portal, and there
 * is no address to retry against, so leaving `promotion_notified_at` null
 * forever would just accumulate permanently-stuck rows. They are counted
 * separately in `noAddress` so a caller can still tell the truth about them.
 *
 * Never throws — a promotion is already committed by the time this runs, and a
 * mail outage must not roll it back or fail the member's cancellation.
 */
export async function notifyWaitlistPromotions(
  promoted: PromotedBooking[],
): Promise<PromotionNotifyResult> {
  const notified: string[] = [];
  let emailed = 0;
  let noAddress = 0;

  for (const p of promoted) {
    if (!p.member_email) {
      notified.push(p.booking_id);
      noAddress += 1;
      continue;
    }
    try {
      const ok = await sendWaitlistPromotionEmail({
        to: p.member_email,
        memberName: p.member_name,
        className: p.class_name,
        startsAt: new Date(p.starts_at),
      });
      if (ok) {
        notified.push(p.booking_id);
        emailed += 1;
      }
    } catch (err) {
      await captureException(err, {
        source: "waitlist-promotion-email",
        severity: "warning",
        bookingId: p.booking_id,
      });
    }
  }

  return { notified, emailed, noAddress };
}

/**
 * The email that closes a right-to-erasure request (beta-gdpr-002): the member
 * asked for their data to be deleted, and this tells them it has been.
 *
 * Under GDPR the controller must inform the subject of the action taken on their
 * Art. 17 request, so this is not a courtesy note — it is the notification that
 * makes the erasure answerable. It is the LAST message this address will ever
 * receive from the gym, and by the time it is sent the address itself is already
 * gone from the database (the caller reads it before erasing — see
 * `completeDeletionRequest`), so nothing here can be re-derived later or
 * retried from stored data.
 *
 * Deliberately carries no personal data beyond the member's own name and no
 * link back into the portal: their account is gone, so a link would 404.
 * Returns whether the send landed, so the caller can record it against the
 * request as the controller's evidence of having notified them.
 */
export async function sendErasureConfirmationEmail(params: {
  to: string;
  memberName: string;
  gymName: string;
}): Promise<boolean> {
  const { to, memberName, gymName } = params;
  const safeName = escapeHtml(memberName);
  const safeGym = escapeHtml(gymName);

  return sendBestEffort(
    {
      to,
      subject: `Your data has been deleted — ${gymName}`,
      html: `<!doctype html><html><body style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#0f172a;line-height:1.5">
        <p>Hi ${safeName},</p>
        <p>Your request to delete your personal data at <strong>${safeGym}</strong> has been completed.</p>
        <p>Your name, email address, phone number, emergency contact, photo and any notes held about you have been removed. Your training history is kept only in anonymised form, with nothing that identifies you, and your portal sign-in no longer works.</p>
        <p>${safeGym} keeps a dated record that this request was made and completed. That record is required to demonstrate the deletion happened and contains no personal data about you.</p>
        <p style="color:#94a3b8;font-size:12px">This is the last email you will receive from us at this address.</p>
      </body></html>`,
      text: [
        `Hi ${memberName},`,
        "",
        `Your request to delete your personal data at ${gymName} has been completed.`,
        "",
        "Your name, email address, phone number, emergency contact, photo and any notes held about you have been removed. Your training history is kept only in anonymised form, with nothing that identifies you, and your portal sign-in no longer works.",
        "",
        `${gymName} keeps a dated record that this request was made and completed. That record is required to demonstrate the deletion happened and contains no personal data about you.`,
        "",
        "This is the last email you will receive from us at this address.",
      ].join("\n"),
    },
    "erasure-confirmation-email",
    { to },
  );
}

export async function sendPaymentFailedEmail(params: {
  to: string;
  memberName: string;
  planName: string;
  retryCount: number;
}): Promise<void> {
  const { to, memberName, planName, retryCount } = params;
  const safeName = escapeHtml(memberName);
  const safePlan = escapeHtml(planName);

  await sendBestEffort(
    {
      to,
      subject: `Payment failed for your ${planName} membership`,
      html: `<!doctype html><html><body style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#0f172a;line-height:1.5">
        <p>Hi ${safeName},</p>
        <p>We couldn't process your latest payment for the <strong>${safePlan}</strong> membership. We'll automatically retry, but please check your card details are up to date to avoid a gap in access.</p>
        <p style="color:#94a3b8;font-size:12px">Attempt ${retryCount} of 3.</p>
      </body></html>`,
      text: `Hi ${memberName},\n\nWe couldn't process your latest payment for the ${planName} membership. We'll automatically retry, but please check your card details are up to date to avoid a gap in access.\n\nAttempt ${retryCount} of 3.`,
    },
    "payment-failed-email",
    { to, planName, retryCount },
  );
}

export async function sendMembershipExpiryEmail(params: {
  to: string;
  memberName: string;
  planName: string;
  expiresAt: Date;
}): Promise<void> {
  const { to, memberName, planName, expiresAt } = params;
  const safeName = escapeHtml(memberName);
  const safePlan = escapeHtml(planName);
  const when = expiresAt.toLocaleDateString("en-GB", { dateStyle: "long" });

  await sendBestEffort(
    {
      to,
      subject: `Your ${planName} membership renews soon`,
      html: `<!doctype html><html><body style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#0f172a;line-height:1.5">
        <p>Hi ${safeName},</p>
        <p>Your <strong>${safePlan}</strong> membership is due to renew on ${when}. No action is needed if your payment details are current.</p>
      </body></html>`,
      text: `Hi ${memberName},\n\nYour ${planName} membership is due to renew on ${when}. No action is needed if your payment details are current.`,
    },
    "membership-expiry-email",
    { to, planName },
  );
}
