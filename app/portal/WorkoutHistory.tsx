import type { WorkoutLogRow } from "../../lib/workout-logs";

/**
 * Read-only "Recent workouts" list for the member portal
 * (Phase GA — ga-engagement-001).
 *
 * Pure presentation: it takes the member's already-resolved logs as props and
 * renders them, so it can be rendered in a test without a session or database.
 * Renders nothing when there is no history (the empty state lives with the
 * "Log a workout" control, which always invites the first entry).
 *
 * Imports are relative (not the `@/` alias) to match `ProgramView` /
 * `ProgramHistory` and stay test-resolvable without a tsconfig-paths plugin.
 */
export function WorkoutHistory({ logs }: { logs: WorkoutLogRow[] }) {
  if (logs.length === 0) return null;

  return (
    <section className="mt-10 flex flex-col gap-3 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-bold text-slate-900">Recent workouts</h2>
      <ul className="flex flex-col gap-2">
        {logs.map((log) => (
          <li
            key={log.id}
            className="flex flex-col gap-1 rounded-xl border border-slate-200 bg-white px-4 py-3"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-sm font-semibold text-slate-900">
                {log.program_name}
              </span>
              <span className="shrink-0 text-xs text-slate-500">
                {new Date(log.completed_at).toLocaleDateString()}
              </span>
            </div>
            {log.effort !== null ? (
              <span className="text-xs font-medium text-slate-500">
                Effort {log.effort}/10
              </span>
            ) : null}
            {log.note ? (
              <p className="whitespace-pre-line text-sm text-slate-600">
                {log.note}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
