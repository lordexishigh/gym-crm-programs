"use server";

import { revalidatePath } from "next/cache";
import { requireMember } from "@/lib/auth/session";
import { logWorkout, validateWorkoutLogInput } from "@/lib/workout-logs";
import { bookClass, cancelBooking, markPromotionNotified } from "@/lib/classes";
import { withTenantContext } from "@/lib/db";
import {
  sendBookingConfirmationEmail,
  notifyWaitlistPromotions,
} from "@/lib/notifications";
import { reportHandledError } from "@/lib/observability/monitoring";

/**
 * Member portal Server Actions (Phase GA — ga-engagement-001).
 *
 * The member portal's first WRITE path. Identity comes from the verified session
 * (`requireMember`), never from the form — the member id we log against is the
 * server-derived one, and RLS rejects a log for anyone else or against an
 * unassigned program regardless. We validate before the round-trip for a
 * friendly error, then revalidate the portal so the new session appears.
 */
export type LogWorkoutState = { error?: string; ok?: boolean };

export async function logWorkoutAction(
  _prevState: LogWorkoutState,
  formData: FormData,
): Promise<LogWorkoutState> {
  const session = await requireMember();
  const memberId = session.identity.memberId as string;

  const parsed = validateWorkoutLogInput({
    programId: formData.get("programId"),
    effort: formData.get("effort"),
    note: formData.get("note"),
  });
  if (!parsed.ok) {
    return { error: parsed.error };
  }

  try {
    await logWorkout(session.identity, memberId, parsed.value);
  } catch {
    // RLS rejecting an unassigned program surfaces as a generic write error; the
    // member should never normally hit this (the form only offers their own
    // active programs), so a friendly message is enough.
    return { error: "Could not log that workout. Please try again." };
  }

  revalidatePath("/portal");
  return { ok: true };
}

export type BookClassState = { error?: string; success?: string };

/**
 * Book the signed-in member into a class (market gap #4). Sends the booking
 * confirmation email (market gap #7) best-effort — a send failure never
 * blocks the booking itself, which already succeeded in the DB.
 */
export async function bookClassAction(
  _prev: BookClassState,
  formData: FormData,
): Promise<BookClassState> {
  const session = await requireMember();
  const memberId = session.identity.memberId as string;
  const classId = String(formData.get("classId") ?? "");
  if (!classId) return { error: "Missing class." };

  const result = await bookClass(session.identity, memberId, classId);
  if (!result.ok) return { error: result.error };

  try {
    const info = await withTenantContext(session.identity, async (c) => {
      const { rows } = await c.query<{
        email: string | null;
        full_name: string;
        class_name: string;
        starts_at: string;
      }>(
        `select m.email, m.full_name, cl.name as class_name, cl.starts_at
           from member m
           cross join classes cl
          where m.id = $1 and cl.id = $2`,
        [memberId, classId],
      );
      return rows[0] ?? null;
    });
    if (info?.email) {
      await sendBookingConfirmationEmail({
        to: info.email,
        memberName: info.full_name,
        className: info.class_name,
        startsAt: new Date(info.starts_at),
        waitlisted: result.status === "waitlisted",
      });
    }
  } catch (err) {
    await reportHandledError(err, "book-class-confirmation-email", {
      tenantId: session.identity.tenantId,
      classId,
    });
  }

  revalidatePath("/portal");
  return {
    success:
      result.status === "waitlisted"
        ? "You're on the waitlist — we'll email you if a spot opens up."
        : "You're booked in!",
  };
}

export type CancelBookingState = { error?: string; success?: string };

/**
 * Cancel the member's own class booking; RLS scopes it to their own row.
 *
 * The freed spot does not stay empty: `cancelBooking` auto-promotes the
 * longest-waiting member off that class's waitlist, and we email whoever moved
 * up. That notify step is deliberately best-effort and swallowed — the
 * cancelling member's request already succeeded, and a mail failure must not
 * be reported back to them as a failed cancellation. The promotion itself is
 * committed either way and shows in the promoted member's portal.
 */
export async function cancelClassBookingAction(
  _prev: CancelBookingState,
  formData: FormData,
): Promise<CancelBookingState> {
  const session = await requireMember();
  const bookingId = String(formData.get("bookingId") ?? "");
  if (!bookingId) return { error: "Missing booking." };

  const result = await cancelBooking(session.identity, bookingId);
  if (!result.ok) return { error: result.error };

  if (result.promoted.length > 0) {
    try {
      const notified = await notifyWaitlistPromotions(result.promoted);
      await markPromotionNotified(session.identity.tenantId, notified);
    } catch (err) {
      await reportHandledError(err, "waitlist-promotion-notify", {
        tenantId: session.identity.tenantId,
        bookingId,
      });
    }
  }

  revalidatePath("/portal");
  return {
    success:
      result.promoted.length > 0
        ? "Booking cancelled — your spot went to the next member on the waitlist."
        : "Booking cancelled.",
  };
}
