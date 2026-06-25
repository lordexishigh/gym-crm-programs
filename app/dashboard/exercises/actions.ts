"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import { resolveStaffUserId } from "@/lib/staff";
import { validateLibraryExerciseInput } from "@/lib/exercise-library";
import { reportHandledError } from "@/lib/observability/monitoring";

/**
 * Per-gym exercise library mutations (alpha-exercise-library-001).
 *
 * Every query runs inside `withTenantContext` as the RLS-bound `app_user`, so a
 * library exercise can only ever be created/read/deleted within the signed-in
 * staff member's own gym — the library is tenant-scoped by construction.
 */

export type LibraryFormState = { error?: string; success?: string };

/** Add an exercise to the gym's reusable library. */
export async function createLibraryExerciseAction(
  _prev: LibraryFormState,
  formData: FormData,
): Promise<LibraryFormState> {
  const session = await requireStaff();

  const parsed = validateLibraryExerciseInput({
    name: formData.get("name"),
    sets: formData.get("sets"),
    reps: formData.get("reps"),
    rest: formData.get("rest"),
    notes: formData.get("notes"),
    category: formData.get("category"),
    imageUrl: formData.get("imageUrl"),
    instructions: formData.get("instructions"),
    guidelines: formData.get("guidelines"),
    tips: formData.get("tips"),
  });
  if (!parsed.ok) return { error: parsed.error };
  const { name, sets, reps, rest, notes, category, imageUrl, instructions, guidelines, tips } =
    parsed.value;

  try {
    await withTenantContext(session.identity, async (c) => {
      const createdBy = await resolveStaffUserId(c, session.identity.userId);
      await c.query(
        `insert into exercise_library
           (tenant_id, name, sets, reps, rest, notes, category, image_url,
            instructions, guidelines, tips, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          session.identity.tenantId,
          name,
          sets,
          reps,
          rest,
          notes,
          category,
          imageUrl,
          instructions,
          guidelines,
          tips,
          createdBy,
        ],
      );
    });
  } catch (err) {
    // The (tenant_id, lower(name)) unique index (migration 0010) rejects a
    // duplicate name within the gym — surface that as actionable guidance
    // rather than the generic retry message (which would falsely imply a glitch).
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "23505"
    ) {
      return {
        error: `“${name}” is already in your library. Pick a different name.`,
      };
    }
    await reportHandledError(err, "create-library-exercise", {
      tenantId: session.identity.tenantId,
    });
    return { error: "Could not add the exercise. Please try again." };
  }

  revalidatePath("/dashboard/exercises");
  return { success: `Added “${name}” to the library.` };
}

/** Remove an exercise from the gym's library (RLS scopes the delete). */
export async function deleteLibraryExerciseAction(
  formData: FormData,
): Promise<void> {
  const session = await requireStaff();

  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/dashboard/exercises");

  await withTenantContext(session.identity, async (c) => {
    await c.query("delete from exercise_library where id = $1", [id]);
  });

  revalidatePath("/dashboard/exercises");
}
