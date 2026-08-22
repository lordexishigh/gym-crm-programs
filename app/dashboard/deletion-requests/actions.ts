"use server";

import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/auth/session";
import {
  completeDeletionRequest,
  declineDeletionRequest,
  normaliseNote,
} from "@/lib/gdpr/deletion-requests";
import { reportHandledError } from "@/lib/observability/monitoring";

/**
 * Staff decisions on member-filed erasure requests (beta-gdpr-002).
 *
 * Both are gated on the `gdpr.manage` capability rather than the bare staff
 * guard they used before the front-desk role existed — "any staff member" now
 * includes the desk, and confirming an erasure is irreversible. They also run
 * through the RLS-scoped client,
 * so a request belonging to another gym is invisible — the decision simply finds
 * no row and reports "not found" rather than acting on someone else's subject.
 *
 * The paths that revalidate are the ones an erasure changes: the roster and the
 * overview counts (which now exclude the erased member), the invite list (their
 * pending invite is revoked), and this queue.
 */
export type DecisionState = { error?: string; success?: string };

function revalidateAfterDecision(): void {
  revalidatePath("/dashboard/deletion-requests");
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/members");
  revalidatePath("/dashboard/invites");
}

/**
 * Confirm a request: the member's data is anonymised and they are emailed.
 *
 * The confirmation email is reported honestly rather than assumed: on a
 * deployment with no mail provider the erasure still happened and the member
 * still has to be told, so staff are told to contact them instead of being shown
 * a success message that isn't true.
 */
export async function confirmDeletionRequestAction(
  _prev: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  const session = await requireCapability("gdpr.manage");

  const requestId = String(formData.get("requestId") ?? "");
  if (!requestId) return { error: "Missing request id." };

  let result: Awaited<ReturnType<typeof completeDeletionRequest>>;
  try {
    result = await completeDeletionRequest(session.identity, requestId);
  } catch (err) {
    await reportHandledError(err, "gdpr-confirm-deletion-request", {
      tenantId: session.identity.tenantId,
      requestId,
    });
    return { error: "Could not complete this request. Please try again." };
  }

  if (!result.ok) {
    return { error: "This request could not be found, or was already decided." };
  }

  revalidateAfterDecision();

  if (result.emailed === "sent") {
    return {
      success: "Data erased. The member has been emailed to confirm.",
    };
  }
  if (result.emailed === "skipped") {
    return {
      success:
        "Data erased. There was no email address on file, so please confirm with the member directly.",
    };
  }
  return {
    success:
      "Data erased, but the confirmation email could not be sent. Please confirm with the member directly.",
  };
}

/** Decline a request, recording the reason the member will be shown. */
export async function declineDeletionRequestAction(
  _prev: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  const session = await requireCapability("gdpr.manage");

  const requestId = String(formData.get("requestId") ?? "");
  if (!requestId) return { error: "Missing request id." };

  // Required, not optional: a refusal the member is given no reason for is not a
  // lawful refusal (Art. 12(4)), and the note is what the portal shows them.
  const note = normaliseNote(formData.get("note"));
  if (!note) {
    return { error: "Give a reason — the member is shown it in their portal." };
  }

  let result: Awaited<ReturnType<typeof declineDeletionRequest>>;
  try {
    result = await declineDeletionRequest(session.identity, requestId, note);
  } catch (err) {
    await reportHandledError(err, "gdpr-decline-deletion-request", {
      tenantId: session.identity.tenantId,
      requestId,
    });
    return { error: "Could not decline this request. Please try again." };
  }

  if (!result.ok) {
    return { error: "This request could not be found, or was already decided." };
  }

  revalidateAfterDecision();
  return { success: "Request declined. The member can see your reason." };
}
