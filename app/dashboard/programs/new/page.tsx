import Link from "next/link";
import { requireStaff } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import type { LibraryExerciseRow } from "@/lib/exercise-library";
import { ProgramBuilder } from "../ProgramBuilder";
import { createProgramAction } from "../actions";

export const dynamic = "force-dynamic";

/** Create-program screen (mvp-program-002 + alpha-exercise-library-001). */
export default async function NewProgramPage() {
  const session = await requireStaff();

  // The gym's library, selectable in the builder (RLS-scoped to this gym).
  const library = await withTenantContext(session.identity, async (c) => {
    const { rows } = await c.query<LibraryExerciseRow>(
      `select id, name, sets, reps, rest, notes
         from exercise_library order by name asc`,
    );
    return rows;
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href="/dashboard/programs"
          className="text-sm font-medium text-slate-500 hover:text-slate-700"
        >
          ← Programs
        </Link>
        <h1 className="text-2xl font-bold">New program</h1>
      </div>

      <ProgramBuilder
        action={createProgramAction}
        submitLabel="Create program"
        library={library}
      />
    </div>
  );
}
