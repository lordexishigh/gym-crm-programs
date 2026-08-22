"use server";

import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/auth/session";
import { checkInByPin, checkInByQrToken } from "@/lib/checkin";
import { reportHandledError } from "@/lib/observability/monitoring";

/**
 * Front-desk kiosk check-in (market gap #5): one input field accepts either a
 * typed 6-digit PIN or a scanned QR token (a barcode/QR scanner wired to the
 * kiosk types the decoded value into the focused input like a keyboard, so
 * one field + one Enter press is the whole interaction — well under 3
 * seconds). A 6-digit numeric string is treated as a PIN; anything else is
 * treated as a QR token.
 */

export type CheckInState = {
  error?: string;
  success?: string;
  /** Which half of the visit the last scan recorded (feedback-2026-08). */
  direction?: "in" | "out";
  /** Who was just checked in — rendered with their photo for visual confirmation. */
  member?: { name: string; avatarSrc: string | null };
};

const PIN_RE = /^\d{6}$/;

export async function kioskCheckInAction(
  _prev: CheckInState,
  formData: FormData,
): Promise<CheckInState> {
  const session = await requireCapability("checkin");
  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { error: "Scan a QR code or enter a PIN." };

  try {
    const result = PIN_RE.test(code)
      ? await checkInByPin(session.identity, code)
      : await checkInByQrToken(session.identity, code);

    if (!result.ok) return { error: result.error };

    revalidatePath("/dashboard/checkin");
    // The occupancy KPI reads from the same table, so the Overview has to be
    // revalidated too or it keeps serving a stale "in the gym now" count.
    revalidatePath("/dashboard");
    return {
      success:
        result.direction === "out"
          ? `Checked out: ${result.memberName}`
          : `Checked in: ${result.memberName}`,
      direction: result.direction,
      member: { name: result.memberName, avatarSrc: result.avatarSrc },
    };
  } catch (err) {
    await reportHandledError(err, "kiosk-checkin", { tenantId: session.identity.tenantId });
    return { error: "Could not check in. Please try again." };
  }
}
