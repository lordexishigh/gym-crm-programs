import type { AssignedProgram, PortalProgram } from "../../lib/portal";
import type { ExerciseRow } from "../../lib/programs";

/**
 * Read-only, mobile-first program view (mvp-member-portal-002).
 *
 * Pure presentation: it takes the member's already-resolved programs as props
 * and renders them. Kept separate from `page.tsx` (which owns session +
 * data-fetching) so the markup can be rendered in a test without a session or
 * database — that test proves every exercise field is surfaced and that NO
 * editing affordances exist (no forms, inputs, edit/delete buttons, or links).
 *
 * Imports are relative (not the `@/` alias) so the view test resolves them
 * without a tsconfig-paths plugin in the Vitest config.
 *
 * Base Tailwind styles target the smallest viewport; `sm:`/`md:` only layer on
 * enhancements for wider screens.
 */
export function ProgramView({ programs }: { programs: PortalProgram[] }) {
  if (programs.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-bold">Your program</h1>
        <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          No program has been assigned to you yet — check back soon.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {programs.map(({ program, exercises }) => (
        <ProgramSection
          key={program.id}
          program={program}
          exercises={exercises}
        />
      ))}
    </div>
  );
}

/** A single assigned program rendered read-only with its ordered exercises. */
function ProgramSection({
  program,
  exercises,
}: {
  program: AssignedProgram;
  exercises: ExerciseRow[];
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">{program.name}</h1>
        {program.description ? (
          <p className="text-sm text-slate-600">{program.description}</p>
        ) : null}
      </div>

      {exercises.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          No exercises in this program yet.
        </div>
      ) : (
        <ol className="flex flex-col gap-3">
          {exercises.map((exercise, index) => (
            <li key={exercise.id}>
              <ExerciseCard exercise={exercise} order={index + 1} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Read-only exercise card: name, the sets/reps/rest stats, and notes. */
function ExerciseCard({
  exercise,
  order,
}: {
  exercise: ExerciseRow;
  order: number;
}) {
  // Each stat label is rendered per-field, only when its value is present; a
  // null/blank field is omitted entirely so a missing value never breaks the
  // layout AND the label string itself ("Sets"/"Reps"/"Rest") is absent.
  const stats: { label: string; value: string }[] = [];
  if (exercise.sets !== null) {
    stats.push({ label: "Sets", value: String(exercise.sets) });
  }
  if (exercise.reps) stats.push({ label: "Reps", value: exercise.reps });
  if (exercise.rest) stats.push({ label: "Rest", value: exercise.rest });

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-semibold text-brand">
          {order}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <h2 className="text-base font-semibold text-slate-900">
            {exercise.name}
          </h2>

          {stats.length > 0 ? (
            <dl className="flex flex-wrap gap-x-6 gap-y-2">
              {stats.map((stat) => (
                <div key={stat.label} className="flex flex-col">
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    {stat.label}
                  </dt>
                  <dd className="text-sm font-semibold text-slate-900">
                    {stat.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}

          {exercise.notes ? (
            <p className="whitespace-pre-line border-t border-slate-100 pt-3 text-sm text-slate-600">
              {exercise.notes}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
