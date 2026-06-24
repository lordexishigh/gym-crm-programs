import {
  ADHERENCE_WINDOW_DAYS,
  type MemberAdherence,
  type WorkoutLogRow,
} from "../../../lib/workout-logs";

/**
 * Read-only "Training adherence" panel for the staff member-detail view
 * (ga-trainer-insights-001).
 *
 * Surfaces the member-WRITTEN workout signal back to trainers so the wedge stops
 * being a one-way broadcast: a summary (last active, recent count, total) plus
 * the member's most recent sessions. Staff never write a member's log — this is
 * presentation only and the page owns the RLS-scoped read, mirroring
 * `StatusHistory` / `ProgramHistory`. That keeps it unit-testable without a
 * session or database, and imports stay relative for the same reason.
 */
function formatDate(iso: string): string {
  // Locale-independent (avoids server/client hydration drift), date-only.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function formatRelative(iso: string | null): string {
  if (!iso) return "Never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return formatDate(iso);
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </dt>
      <dd className="text-base font-semibold text-slate-900">{value}</dd>
    </div>
  );
}

export function WorkoutAdherence({
  adherence,
  logs,
}: {
  adherence: MemberAdherence;
  logs: WorkoutLogRow[];
}) {
  const stale = adherence.recentSessions === 0;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-slate-900">Training adherence</h2>

      <dl className="grid grid-cols-3 gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <Stat label="Last active" value={formatRelative(adherence.lastCompletedAt)} />
        <Stat
          label={`Last ${ADHERENCE_WINDOW_DAYS} days`}
          value={adherence.recentSessions}
        />
        <Stat label="Total sessions" value={adherence.totalSessions} />
      </dl>

      {adherence.totalSessions > 0 && stale ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-700">
          No sessions logged in the last {ADHERENCE_WINDOW_DAYS} days — this
          member may have stopped training.
        </p>
      ) : null}

      {logs.length === 0 ? (
        <p className="text-sm text-slate-500">
          No workouts logged yet. Sessions a member records on their portal will
          appear here.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {logs.map((log) => (
            <li
              key={log.id}
              className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-medium text-slate-900">
                  {log.program_name}
                </span>
                {log.note ? (
                  <p className="whitespace-pre-line text-slate-600">{log.note}</p>
                ) : null}
              </div>
              <span className="flex shrink-0 items-center gap-2 text-xs text-slate-500">
                {log.effort !== null ? (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
                    Effort {log.effort}/10
                  </span>
                ) : null}
                {formatDate(log.completed_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
