import type { MemberStatusEvent } from "../../../lib/member-records";

/**
 * Read-only "Status history" list for the member detail view
 * (alpha-member-records-001).
 *
 * A pure presentational component: it takes already-loaded events and renders
 * them, so the detail page owns the RLS-scoped read and this stays unit-testable
 * without a session or database — the same split as `ProgramHistory`. Unlike the
 * portal's optional "Past programs" list, this is a permanent section of the
 * detail screen, so it renders a heading + empty message rather than nothing.
 *
 * Imports are relative (not the `@/` alias) to match `ProgramHistory` and stay
 * test-resolvable without a tsconfig-paths plugin.
 */
function formatDateTime(iso: string): string {
  // Stable, locale-independent rendering (avoids server/client hydration drift).
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function StatusHistory({ events }: { events: MemberStatusEvent[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold text-slate-900">Status history</h2>
      {events.length === 0 ? (
        <p className="text-sm text-slate-500">No status changes recorded yet.</p>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {events.map((e, i) => (
            <li
              key={`${e.changed_at}-${i}`}
              className="flex items-center justify-between gap-4 px-4 py-3 text-sm"
            >
              <span className="text-slate-900">
                {e.old_status ? (
                  <>
                    {e.old_status} <span className="text-slate-400">→</span>{" "}
                    {e.new_status}
                  </>
                ) : (
                  <>Created as {e.new_status}</>
                )}
              </span>
              <span className="shrink-0 text-right text-xs text-slate-500">
                {formatDateTime(e.changed_at)}
                {e.changed_by_name ? ` · ${e.changed_by_name}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
