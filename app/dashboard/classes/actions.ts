"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/session";
import { validateClassInput, createClass, cancelBooking } from "@/lib/classes";
import { resolveStaffUserId } from "@/lib/staff";
import { withTenantContext } from "@/lib/db";
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
  const session = await requireStaff();

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

/** Staff-side booking cancellation (front desk / no-show handling). */
export async function staffCancelBookingAction(formData: FormData): Promise<void> {
  const session = await requireStaff();
  const bookingId = String(formData.get("bookingId") ?? "");
  if (!bookingId) return;

  try {
    await cancelBooking(session.identity, bookingId);
  } catch (err) {
    await reportHandledError(err, "staff-cancel-booking", {
      tenantId: session.identity.tenantId,
      bookingId,
    });
  }

  revalidatePath("/dashboard/classes");
}
