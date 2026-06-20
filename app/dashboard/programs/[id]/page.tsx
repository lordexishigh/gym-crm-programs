import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import type { ExerciseRow, ProgramRow } from "@/lib/programs";
import type { LibraryExerciseRow } from "@/lib/exercise-library";
import { ProgramBuilder } from "../ProgramBuilder";
import { AssignPanel } from "../AssignPanel";
import { updateProgramAction } from "../actions";
import { saveProgramAsTemplateAction } from "../../templates/actions";

export const dynamic = "force-dynamic";

type MemberOption = { id: string; full_name: string };
type AssignmentRow = {
  member_id: string;
  full_name: string;
  assigned_at: string;
};

/**
 * Program detail / edit screen (mvp-program-002/004). Loads the program, its
 * ordered exercises, the gym's members (for the assign picker), and current
 * active assignments — all under RLS, so a cross-tenant id resolves to no row
 * and 404s. Shows the builder (edit) plus the assignment control.
 */
export default async function ProgramDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireStaff();

  const data = await withTenantContext(session.identity, async (c) => {
    const program = (
      await c.query<ProgramRow>(
        `select id, name, description, created_at, updated_at
           from program where id = $1`,
        [id],
      )
    ).rows[0];
    if (!program) return null;

    const exercises = (
      await c.query<ExerciseRow>(
        `select id, program_id, position, name, sets, reps, rest, notes
           from exercise
          where program_id = $1
          order by position asc`,
        [id],
      )
    ).rows;

    const members = (
      await c.query<MemberOption>(
        "select id, full_name from member order by full_name asc",
      )
    ).rows;

    const assignments = (
      await c.query<AssignmentRow>(
        `select pa.member_id, m.full_name, pa.assigned_at
           from program_assignment pa
           join member m on m.id = pa.member_id
          where pa.program_id = $1 and pa.status = 'active'
          order by m.full_name asc`,
        [id],
      )
    ).rows;

    const library = (
      await c.query<LibraryExerciseRow>(
        `select id, name, sets, reps, rest, notes
           from exercise_library order by name asc`,
      )
    ).rows;

    return { program, exercises, members, assignments, library };
  });

  if (!data) notFound();
  const { program, exercises, members, assignments, library } = data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link
            href="/dashboard/programs"
            className="text-sm font-medium text-slate-500 hover:text-slate-700"
          >
            ← Programs
          </Link>
          <h1 className="text-2xl font-bold">{program.name}</h1>
        </div>
        <form action={saveProgramAsTemplateAction} className="shrink-0">
          <input type="hidden" name="programId" value={program.id} />
          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
          >
            Save as template
          </button>
        </form>
      </div>

      <ProgramBuilder
        action={updateProgramAction}
        submitLabel="Save changes"
        library={library}
        defaults={{
          id: program.id,
          name: program.name,
          description: program.description ?? "",
          exercises: exercises.map((e) => ({
            name: e.name,
            sets: e.sets,
            reps: e.reps,
            rest: e.rest,
            notes: e.notes,
          })),
        }}
      />

      <AssignPanel
        programId={program.id}
        members={members}
        assignments={assignments}
      />
    </div>
  );
}
