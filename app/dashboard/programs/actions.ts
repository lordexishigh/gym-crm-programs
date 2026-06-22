"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { PoolClient } from "pg";
import { requireStaff } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import { validateProgramInput, type ExerciseInput } from "@/lib/programs";
import { reassignProgram } from "@/lib/assignments";
import { reportHandledError } from "@/lib/observability/monitoring";

/**
 * Staff-facing program authoring + assignment mutations (mvp-program-001/003).
 *
 * Every query runs inside `withTenantContext` as the RLS-bound `app_user`, so a
 * program, its exercises, and any assignment can only ever be created/read/
 * updated within the signed-in staff member's own gym — application code never
 * has to add `where tenant_id = …`, and a cross-tenant id silently matches no
 * row (RLS) or is rejected by the composite (id, tenant_id) FKs.
 */

export type ProgramFormState = { error?: string };

/** Parse the builder's serialised exercises hidden field. */
function parseExercises(raw: FormDataEntryValue | null): unknown {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return JSON.parse(raw);
}

/** Resolve the signed-in staff member's `users.id` (FK target), best-effort. */
async function resolveStaffUserId(
  c: PoolClient,
  authUserId: string | null | undefined,
): Promise<string | null> {
  if (!authUserId) return null;
  const { rows } = await c.query<{ id: string }>(
    "select id from users where auth_user_id = $1",
    [authUserId],
  );
  return rows[0]?.id ?? null;
}

/** Insert exercises for a program in array order; `position` is the index. */
async function insertExercises(
  c: PoolClient,
  tenantId: string,
  programId: string,
  exercises: ExerciseInput[],
): Promise<void> {
  for (let i = 0; i < exercises.length; i++) {
    const e = exercises[i];
    await c.query(
      `insert into exercise
         (tenant_id, program_id, position, name, sets, reps, rest, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tenantId, programId, i, e.name, e.sets, e.reps, e.rest, e.notes],
    );
  }
}

/** Create a program with its ordered exercises, then go to its detail page. */
export async function createProgramAction(
  _prev: ProgramFormState,
  formData: FormData,
): Promise<ProgramFormState> {
  const session = await requireStaff();

  let exercisesRaw: unknown;
  try {
    exercisesRaw = parseExercises(formData.get("exercises"));
  } catch {
    return { error: "Could not read the exercises. Please try again." };
  }

  const parsed = validateProgramInput({
    name: formData.get("name"),
    description: formData.get("description"),
    exercises: exercisesRaw,
  });
  if (!parsed.ok) return { error: parsed.error };
  const { name, description, exercises } = parsed.value;

  let newId: string;
  try {
    newId = await withTenantContext(session.identity, async (c) => {
      const createdBy = await resolveStaffUserId(c, session.identity.userId);
      const { rows } = await c.query<{ id: string }>(
        `insert into program (tenant_id, name, description, created_by)
         values ($1, $2, $3, $4)
         returning id`,
        [session.identity.tenantId, name, description, createdBy],
      );
      const programId = rows[0].id;
      await insertExercises(c, session.identity.tenantId, programId, exercises);
      return programId;
    });
  } catch (err) {
    await reportHandledError(err, "create-program", {
      tenantId: session.identity.tenantId,
    });
    return { error: "Could not save the program. Please try again." };
  }

  revalidatePath("/dashboard/programs");
  redirect(`/dashboard/programs/${newId}`);
}

/**
 * Update a program and replace its exercises in one transaction. Replacing
 * (delete-then-insert in array order) is the simplest correct way to persist
 * edits, removals, and reordering together — the whole set is rewritten so the
 * stored order always matches what the trainer sees.
 */
export async function updateProgramAction(
  _prev: ProgramFormState,
  formData: FormData,
): Promise<ProgramFormState> {
  const session = await requireStaff();

  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Missing program id." };

  let exercisesRaw: unknown;
  try {
    exercisesRaw = parseExercises(formData.get("exercises"));
  } catch {
    return { error: "Could not read the exercises. Please try again." };
  }

  const parsed = validateProgramInput({
    name: formData.get("name"),
    description: formData.get("description"),
    exercises: exercisesRaw,
  });
  if (!parsed.ok) return { error: parsed.error };
  const { name, description, exercises } = parsed.value;

  let outcome: "ok" | "not_found";
  try {
    outcome = await withTenantContext(session.identity, async (c) => {
      const res = await c.query(
        `update program
            set name = $2, description = $3, updated_at = now()
          where id = $1`,
        [id, name, description],
      );
      // RLS makes a cross-tenant id silently match nothing.
      if ((res.rowCount ?? 0) === 0) return "not_found";

      // Replace the exercise set wholesale (RLS scopes the delete to this gym).
      await c.query("delete from exercise where program_id = $1", [id]);
      await insertExercises(c, session.identity.tenantId, id, exercises);
      return "ok";
    });
  } catch (err) {
    await reportHandledError(err, "update-program", {
      tenantId: session.identity.tenantId,
      programId: id,
    });
    return { error: "Could not save changes. Please try again." };
  }

  if (outcome === "not_found") return { error: "Program not found." };

  revalidatePath("/dashboard/programs");
  revalidatePath(`/dashboard/programs/${id}`);
  redirect(`/dashboard/programs/${id}`);
}

export type AssignState = { error?: string; success?: string };

/**
 * Assign a program to a member (mvp-program-003). Both must belong to the
 * signed-in staff member's gym: RLS scopes the existence checks so a program or
 * member id from another tenant resolves to no row and is rejected here — and
 * even a forged insert would fail the composite (id, tenant_id) FK with-check.
 *
 * A member has at most one ACTIVE program: assigning a different program
 * archives whichever was active (alpha-program-lifecycle-001). Re-assigning the
 * same program just refreshes it. The archive-prior + upsert is delegated to
 * `reassignProgram` (shared with the lifecycle test) and enforced server-side
 * by the partial unique index from migration 0003.
 */
export async function assignProgramAction(
  _prev: AssignState,
  formData: FormData,
): Promise<AssignState> {
  const session = await requireStaff();

  const programId = String(formData.get("programId") ?? "");
  const memberId = String(formData.get("memberId") ?? "");
  if (!programId) return { error: "Missing program id." };
  if (!memberId) return { error: "Select a member to assign." };

  let result: "ok" | "program_missing" | "member_missing";
  try {
    result = await withTenantContext(session.identity, async (c) => {
      const program = (
        await c.query<{ id: string }>(
          "select id from program where id = $1",
          [programId],
        )
      ).rows[0];
      if (!program) return "program_missing";

      const member = (
        await c.query<{ id: string }>("select id from member where id = $1", [
          memberId,
        ])
      ).rows[0];
      if (!member) return "member_missing";

      const assignedBy = await resolveStaffUserId(c, session.identity.userId);

      await reassignProgram(c, {
        tenantId: session.identity.tenantId,
        programId,
        memberId,
        assignedBy,
      });
      return "ok";
    });
  } catch (err) {
    await reportHandledError(err, "assign-program", {
      tenantId: session.identity.tenantId,
      programId,
      memberId,
    });
    return { error: "Could not assign the program. Please try again." };
  }

  if (result === "program_missing") return { error: "Program not found." };
  if (result === "member_missing") {
    return { error: "That member isn't in your gym." };
  }

  revalidatePath(`/dashboard/programs/${programId}`);
  return { success: "Program assigned." };
}

/**
 * Remove (unassign) a program from a member (mvp-program-004 — lets staff
 * correct/replace assignments). Deleting is scoped to the gym by RLS.
 */
export async function unassignProgramAction(
  _prev: AssignState,
  formData: FormData,
): Promise<AssignState> {
  const session = await requireStaff();

  const programId = String(formData.get("programId") ?? "");
  const memberId = String(formData.get("memberId") ?? "");
  if (!programId || !memberId) return { error: "Missing assignment details." };

  try {
    await withTenantContext(session.identity, async (c) => {
      await c.query(
        "delete from program_assignment where program_id = $1 and member_id = $2",
        [programId, memberId],
      );
    });
  } catch (err) {
    await reportHandledError(err, "unassign-program", {
      tenantId: session.identity.tenantId,
      programId,
      memberId,
    });
    return { error: "Could not remove the assignment. Please try again." };
  }

  revalidatePath(`/dashboard/programs/${programId}`);
  return { success: "Assignment removed." };
}
