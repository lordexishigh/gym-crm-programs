import { requireStaff } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import type { LibraryExerciseRow } from "@/lib/exercise-library";
import { ExerciseLibraryForm } from "./ExerciseLibraryForm";
import { deleteLibraryExerciseAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Exercise library (alpha-exercise-library-001). The query carries no tenant
 * predicate — RLS (`exercise_library_staff_all`) scopes it to the staff
 * member's gym, so only the current gym's catalog can ever appear. These
 * exercises are selectable when building a program (see ProgramBuilder).
 */
export default async function ExerciseLibraryPage() {
  const session = await requireStaff();

  const exercises = await withTenantContext(session.identity, async (c) => {
    const { rows } = await c.query<LibraryExerciseRow>(
      `select id, name, sets, reps, rest, notes
         from exercise_library
        order by name asc`,
    );
    return rows;
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Exercise library</h1>
        <p className="text-sm text-slate-600">
          A reusable catalog for your gym. Add exercises here, then insert them
          when building a program.
        </p>
      </div>

      <ExerciseLibraryForm />

      <div className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-slate-900">
          Library ({exercises.length})
        </h2>

        {exercises.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
            No exercises yet. Add your first exercise above to start your gym’s
            library.
          </div>
        ) : (
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
            {exercises.map((e) => {
              const stats = [
                e.sets !== null ? `${e.sets} sets` : null,
                e.reps ? `${e.reps} reps` : null,
                e.rest ? `${e.rest} rest` : null,
              ].filter(Boolean);
              return (
                <li
                  key={e.id}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium text-slate-900">
                      {e.name}
                    </span>
                    <span className="truncate text-sm text-slate-500">
                      {stats.length > 0 ? stats.join(" · ") : "No defaults"}
                      {e.notes ? ` — ${e.notes}` : ""}
                    </span>
                  </div>
                  <form action={deleteLibraryExerciseAction} className="shrink-0">
                    <input type="hidden" name="id" value={e.id} />
                    <button
                      type="submit"
                      aria-label={`Remove ${e.name} from the library`}
                      className="rounded-md border border-slate-300 px-2 py-1 text-sm font-medium text-red-600 transition hover:bg-red-50"
                    >
                      Remove
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
