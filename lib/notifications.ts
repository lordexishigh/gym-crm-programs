import { sendEmail } from "@/lib/email/resend";
import { captureException } from "@/lib/observability/monitoring";

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

async function sendBestEffort(
  message: Parameters<typeof sendEmail>[0],
  source: string,
  context: Record<string, unknown>,
): Promise<void> {
  const result = await sendEmail(message);
  if (!result.ok) {
    await captureException(new Error(`${source} email failed: ${result.error}`), {
      source,
      severity: "warning",
      ...context,
    });
  }
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
