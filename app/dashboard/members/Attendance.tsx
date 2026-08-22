import type { MemberAttendance } from "../../../lib/checkin";

/**
 * A member's attendance history on the member detail page.
 *
 * This is the front desk's core lookup — "when were they last in?", "how many
 * visits have they had?" — and the reason the Front Desk role can open a member
 * record at all. It sits apart from the Activity timeline deliberately: a
 * visit log is scanned as a column of dates and durations, and interleaving it
 * with program assignments and invites would bury exactly the pattern someone
 * is looking for.
 *
 * Purely presentational, like `Timeline` / `WorkoutAdherence`: it renders an
 * already RLS-scoped result. Imports stay relative to match its siblings.
 */
function formatDay(iso: string): string {
  // Stable and locale-independent, matching Timeline (no hydration drift).
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(11, 16);
}

/** "1h 20m" between the two ends of a closed visit; null while it is open. */
function formatDuration(from: string, to: string | null): string | null {
  if (!to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

export function Attendance({ attendance }: { attendance: MemberAttendance }) {
  const { visits, totalVisits, lastVisitAt } = attendance;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-900">Attendance</h2>
        <p className="text-sm text-slate-500">
          {totalVisits === 0
            ? "No visits recorded"
            : `${totalVisits} visit${totalVisits === 1 ? "" : "s"} · last on ${formatDay(lastVisitAt!)}`}
        </p>
      </div>

      {visits.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500">
          This member has not checked in yet. Visits appear here as soon as they
          scan their PIN or QR code at the desk.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {visits.map((visit) => {
            const duration = formatDuration(
              visit.checked_in_at,
              visit.checked_out_at,
            );
            return (
              <li
                key={visit.id}
                className="flex items-center justify-between gap-4 px-4 py-3 text-sm"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-slate-900">
                    {formatDay(visit.checked_in_at)}
                    {visit.is_present ? (
                      <span className="shrink-0 rounded-full bg-brand/15 px-2 py-0.5 text-xs font-medium text-brand">
                        In now
                      </span>
                    ) : null}
                  </span>
                  <span className="text-xs text-slate-500">
                    {visit.method.toUpperCase()} · {formatClock(visit.checked_in_at)}
                    {visit.checked_out_at
                      ? ` – ${formatClock(visit.checked_out_at)} UTC`
                      : " UTC"}
                  </span>
                </div>
                <span className="shrink-0 text-right text-xs text-slate-500">
                  {duration ?? (visit.is_present ? "Still in" : "No check-out")}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
