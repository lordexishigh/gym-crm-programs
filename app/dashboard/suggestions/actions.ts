"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/session";
import { reviewSuggestion } from "@/lib/suggestions";
import { reportHandledError } from "@/lib/observability/monitoring";

/**
 * Recording a trainer's decision on a suggestion.
 *
 * Any staff member may review — a trainer acting on their own members' briefs is
 * the whole point, so this is not owner-gated the way billing is.
 *
 * `reviewed_by` is taken from the verified session inside `reviewSuggestion`,
 * never from the form. The audit trail is the reason this table exists (a
 * derived claim about a member's training was acted on by a NAMED human), and a
 * browser-supplied author would make it worthless.
 */

export type ReviewFormState = { error?: string; success?: string };

export async function reviewSuggestionAction(
  _prev: ReviewFormState,
  formData: FormData,
): Promise<ReviewFormState> {
  const session = await requireStaff();

  const id = String(formData.get("id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  if (!id) return { error: "Missing suggestion id." };
  if (decision !== "accepted" && decision !== "dismissed") {
    // Never trust a form value for control flow — anything but the two known
    // decisions is rejected rather than coerced.
    return { error: "Unknown decision." };
  }

  try {
    const decided = await reviewSuggestion(
      session.identity,
      id,
      decision,
      note || undefined,
    );
    if (!decided) {
      // Already reviewed — a double-submit, or a colleague got there first. Not
      // an error: the outcome the trainer wanted is already true, and the first
      // decision (with its author) is deliberately not overwritten.
      revalidatePath("/dashboard/suggestions");
      return { success: "Already reviewed." };
    }
  } catch (err) {
    await reportHandledError(err, "review-suggestion", {
      tenantId: session.identity.tenantId,
      suggestionId: id,
    });
    return { error: "Could not record your decision. Please try again." };
  }

  revalidatePath("/dashboard/suggestions");
  revalidatePath("/dashboard");
  return {
    success:
      decision === "accepted" ? "Marked as actioned." : "Dismissed.",
  };
}
