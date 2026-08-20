"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { PoolClient } from "pg";
import { requireCapability } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import { resolveStaffUserId } from "@/lib/staff";
import { reportHandledError } from "@/lib/observability/monitoring";

/**
 * Program template mutations (alpha-exercise-library-002).
 *
 * Both operations are pure copies inside one `withTenantContext` transaction, so
 * RLS scopes every read/write to the signed-in staff member's gym: a program or
 * template id from another tenant resolves to no row, and the composite
 * (id, tenant_id) FKs reject any cross-tenant child insert.
 */

type ExerciseCopyRow = {
  name: string;
  sets: number | null;
  reps: string | null;
  rest: string | null;
  notes: string | null;
};

/** Insert copied exercises in array order; `position` is the index. */
async function insertOrdered(
  c: PoolClient,
  table: "exercise" | "template_exercise",
  fkColumn: "program_id" | "template_id",
  tenantId: string,
  fkId: string,
  rows: ExerciseCopyRow[],
): Promise<void> {
  for (let i = 0; i < rows.length; i++) {
    const e = rows[i];
    await c.query(
      `insert into ${table}
         (tenant_id, ${fkColumn}, position, name, sets, reps, rest, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tenantId, fkId, i, e.name, e.sets, e.reps, e.rest, e.notes],
    );
  }
}

/**
 * Save an existing program as a reusable template — copies its name,
 * description, and ordered exercises into program_template / template_exercise.
 * Operates on the persisted program (so the trainer saves edits first).
 */
export async function saveProgramAsTemplateAction(
  formData: FormData,
): Promise<void> {
  const session = await requireCapability("programs.write");

  const programId = String(formData.get("programId") ?? "");
  if (!programId) redirect("/dashboard/programs");

  let saved = false;
  try {
    saved = await withTenantContext(session.identity, async (c) => {
      const program = (
        await c.query<{ name: string; description: string | null }>(
          "select name, description from program where id = $1",
          [programId],
        )
      ).rows[0];
      if (!program) return false; // cross-tenant / missing → RLS shows no row

      const exercises = (
        await c.query<ExerciseCopyRow>(
          `select name, sets, reps, rest, notes
             from exercise where program_id = $1 order by position asc`,
          [programId],
        )
      ).rows;

      const createdBy = await resolveStaffUserId(c, session.identity.userId);
      const templateId = (
        await c.query<{ id: string }>(
          `insert into program_template (tenant_id, name, description, created_by)
           values ($1, $2, $3, $4) returning id`,
          [session.identity.tenantId, program.name, program.description, createdBy],
        )
      ).rows[0].id;

      await insertOrdered(
        c,
        "template_exercise",
        "template_id",
        session.identity.tenantId,
        templateId,
        exercises,
      );
      return true;
    });
  } catch (err) {
    await reportHandledError(err, "save-program-as-template", {
      tenantId: session.identity.tenantId,
      programId,
    });
    saved = false;
  }

  if (saved) {
    revalidatePath("/dashboard/templates");
    redirect("/dashboard/templates");
  }
  // Couldn't save (missing program or error) — return to the program.
  redirect(`/dashboard/programs/${programId}`);
}

/**
 * Instantiate a template into a new program — copies its name, description, and
 * ordered exercises into program / exercise, then opens the new program so the
 * trainer can tweak and assign it.
 */
export async function createProgramFromTemplateAction(
  formData: FormData,
): Promise<void> {
  const session = await requireCapability("programs.write");

  const templateId = String(formData.get("templateId") ?? "");
  if (!templateId) redirect("/dashboard/templates");

  let newProgramId: string | null = null;
  try {
    newProgramId = await withTenantContext(session.identity, async (c) => {
      const template = (
        await c.query<{ name: string; description: string | null }>(
          "select name, description from program_template where id = $1",
          [templateId],
        )
      ).rows[0];
      if (!template) return null; // cross-tenant / missing → RLS shows no row

      const exercises = (
        await c.query<ExerciseCopyRow>(
          `select name, sets, reps, rest, notes
             from template_exercise where template_id = $1 order by position asc`,
          [templateId],
        )
      ).rows;

      const createdBy = await resolveStaffUserId(c, session.identity.userId);
      const programId = (
        await c.query<{ id: string }>(
          `insert into program (tenant_id, name, description, created_by)
           values ($1, $2, $3, $4) returning id`,
          [session.identity.tenantId, template.name, template.description, createdBy],
        )
      ).rows[0].id;

      await insertOrdered(
        c,
        "exercise",
        "program_id",
        session.identity.tenantId,
        programId,
        exercises,
      );
      return programId;
    });
  } catch (err) {
    await reportHandledError(err, "create-program-from-template", {
      tenantId: session.identity.tenantId,
      templateId,
    });
    newProgramId = null;
  }

  if (!newProgramId) redirect("/dashboard/templates");
  revalidatePath("/dashboard/programs");
  redirect(`/dashboard/programs/${newProgramId}`);
}

/** Delete a template (and its exercises, via FK cascade). RLS scopes it. */
export async function deleteTemplateAction(formData: FormData): Promise<void> {
  const session = await requireCapability("programs.write");

  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/dashboard/templates");

  await withTenantContext(session.identity, async (c) => {
    await c.query("delete from program_template where id = $1", [id]);
  });

  revalidatePath("/dashboard/templates");
}
