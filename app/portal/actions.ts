"use server";

import { revalidatePath } from "next/cache";
import { requireMember } from "@/lib/auth/session";
import { logWorkout, validateWorkoutLogInput } from "@/lib/workout-logs";

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
