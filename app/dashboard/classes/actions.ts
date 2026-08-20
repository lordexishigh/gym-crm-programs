"use server";

import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/auth/session";
import {
  validateClassInput,
  createClass,
  cancelBooking,
  promoteFromWaitlist,
  markPromotionNotified,
  type PromotedBooking,
} from "@/lib/classes";
import { resolveStaffUserId } from "@/lib/staff";
import { withTenantContext } from "@/lib/db";
import { notifyWaitlistPromotions } from "@/lib/notifications";
import { reportHandledError } from "@/lib/observability/monitoring";

/**
 * Staff class-scheduling mutations (market gap #4). Any staff member
 * (owner or trainer) can create classes and cancel bookings from the front
 * desk — scheduling isn't gated by owner/trainer, unlike billing.
 */

export type ClassFormState = { error?: string; success?: string };

export async function createClassAction(
  _prev: ClassFormState,
  formData: FormData,
): Promise<ClassFormState> {
  const session = await requireCapability("classes.write");

  const parsed = validateClassInput({
    name: formData.get("name"),
    instructorName: formData.get("instructorName"),
    startsAt: formData.get("startsAt"),
    durationMinutes: formData.get("durationMinutes"),
    capacity: formData.get("capacity"),
  });
  if (!parsed.ok) return { error: parsed.error };

  try {
    const instructorId = await withTenantContext(session.identity, (c) =>
      resolveStaffUserId(c, session.identity.userId),
    );
    await createClass(session.identity, parsed.value, instructorId);
  } catch (err) {
    await reportHandledError(err, "create-class", { tenantId: session.identity.tenantId });
    return { error: "Could not save the class. Please try again." };
  }

  revalidatePath("/dashboard/classes");
  return { success: `“${parsed.value.name}” scheduled.` };
}

/**
 * Email the members a promotion just moved onto a confirmed spot, then record
 * that we did so. Best-effort by construction: the promotion is already
 * committed, so a mail outage must never surface as a failed cancellation or
 * roll anything back — it is reported and swallowed.
 *
 * Not exported: a "use server" module may only export async server actions, and
 * this is an internal helper, not a form target.
 */
async function deliverPromotionEmails(
  tenantId: string,
  promoted: PromotedBooking[],
): Promise<void> {
  if (promoted.length === 0) return;
  try {
    const notified = await notifyWaitlistPromotions(promoted);
    await markPromotionNotified(tenantId, notified);
  } catch (err) {
    await reportHandledError(err, "waitlist-promotion-notify", { tenantId });
  }
}

/**
 * Staff-side booking cancellation (front desk / no-show handling). Cancelling
 * a confirmed spot auto-promotes the longest-waiting member on the waitlist and
 * emails them — the front desk does not have to chase anyone manually.
 */
export async function staffCancelBookingAction(formData: FormData): Promise<void> {
  const session = await requireCapability("classes.write");
  const bookingId = String(formData.get("bookingId") ?? "");
  if (!bookingId) return;

  try {
    const result = await cancelBooking(session.identity, bookingId);
    if (result.ok) {
      await deliverPromotionEmails(session.identity.tenantId, result.promoted);
    }
  } catch (err) {
    await reportHandledError(err, "staff-cancel-booking", {
      tenantId: session.identity.tenantId,
      bookingId,
    });
  }

  revalidatePath("/dashboard/classes");
}

export type PromoteWaitlistState = { error?: string; success?: string };

/**
 * Explicitly fill a class's open spots from its waitlist, and email everyone
 * promoted.
 *
 * Cancellations already trigger this automatically, so in normal operation this
 * button has nothing to do. It exists because vacancies can appear by other
 * routes — a class whose capacity a gym raises, a booking removed directly in
 * the database, a promotion that could not complete because the row was locked
 * by a concurrent cancellation — and without a manual trigger those seats stay
 * empty while members sit on the waitlist. `promoteFromWaitlist` is capacity-
 * driven and idempotent, so pressing this with nothing free is a safe no-op.
 */
export async function promoteFromWaitlistAction(
  _prev: PromoteWaitlistState,
  formData: FormData,
): Promise<PromoteWaitlistState> {
  const session = await requireCapability("classes.write");
  const classId = String(formData.get("classId") ?? "");
  if (!classId) return { error: "Missing class." };

  let promoted: PromotedBooking[];
  try {
    promoted = await promoteFromWaitlist(session.identity.tenantId, classId);
  } catch (err) {
    await reportHandledError(err, "promote-from-waitlist", {
      tenantId: session.identity.tenantId,
      classId,
    });
    return { error: "Could not promote from the waitlist. Please try again." };
  }

  await deliverPromotionEmails(session.identity.tenantId, promoted);

  revalidatePath(`/dashboard/classes/${classId}`);
  revalidatePath("/dashboard/classes");

  if (promoted.length === 0) {
    return { success: "No open spots to fill — the class is full." };
  }
  const names = promoted.map((p) => p.member_name).join(", ");
  return {
    success:
      promoted.length === 1
        ? `${names} was moved off the waitlist and emailed.`
        : `${promoted.length} members were moved off the waitlist and emailed: ${names}.`,
  };
}
