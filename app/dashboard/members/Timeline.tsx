import type { TimelineEntry } from "../../../lib/timeline";

/**
 * Member-detail activity timeline (CRM-IDEAS "Apply now" #4): one
 * chronological feed of status changes, program assignments, invite events,
 * and logged workouts, replacing the narrower "Status history" section.
 *
 * A pure presentational component — it takes an already-merged, already
 * RLS-scoped list and renders it, the same split as `StatusHistory` /
 * `ProgramHistory` / `WorkoutAdherence`. Imports stay relative to match.
 */
function formatDateTime(iso: string): string {
  // Stable, locale-independent rendering (avoids server/client hydration drift).
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function describe(entry: TimelineEntry): string {
  switch (entry.kind) {
    case "status":
      return entry.oldStatus
        ? `Status changed: ${entry.oldStatus} → ${entry.newStatus}`
        : `Created as ${entry.newStatus}`;
    case "assignment":
      return entry.status === "archived"
        ? `Program assigned: ${entry.programName} (now archived)`
        : `Program assigned: ${entry.programName}`;
    case "invite-sent":
      return `Invite sent to ${entry.email}`;
    case "invite-accepted":
      return `Invite accepted (${entry.email})`;
    case "workout":
      return `Logged a workout: ${entry.programName}`;
  }
}

function detail(entry: TimelineEntry): string | null {
  if (entry.kind === "status" && entry.changedByName) {
    return entry.changedByName;
  }
  if (entry.kind === "workout") {
    const parts: string[] = [];
    if (entry.effort !== null) parts.push(`Effort ${entry.effort}/10`);
    if (entry.note) parts.push(entry.note);
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  return null;
}

export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold text-slate-900">Activity</h2>
      {entries.length === 0 ? (
        <p className="text-sm text-slate-500">No activity recorded yet.</p>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {entries.map((entry, i) => (
            <li
              key={`${entry.kind}-${entry.occurredAt}-${i}`}
              className="flex items-center justify-between gap-4 px-4 py-3 text-sm"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-slate-900">{describe(entry)}</span>
                {detail(entry) ? (
                  <span className="truncate text-xs text-slate-500">
                    {detail(entry)}
                  </span>
                ) : null}
              </div>
              <span className="shrink-0 text-right text-xs text-slate-500">
                {formatDateTime(entry.occurredAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
