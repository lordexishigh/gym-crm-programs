import Link from "next/link";
import type { AssignedProgram } from "../../lib/portal";

/**
 * Read-only "Past programs" list for the member portal
 * (alpha-program-lifecycle-002).
 *
 * Rendered on the portal home BELOW the active program. Deliberately kept out of
 * `ProgramView` (whose test asserts it has no links at all): this list is pure
 * navigation — each item links to a read-only detail page, with no editing
 * affordances. Renders nothing when there is no history.
 *
 * Imports are relative (not the `@/` alias) to match `ProgramView` and stay
 * test-resolvable without a tsconfig-paths plugin.
 */
export function ProgramHistory({
  programs,
}: {
  programs: AssignedProgram[];
}) {
  if (programs.length === 0) return null;

  return (
    <section className="mt-10 flex flex-col gap-3 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-bold text-slate-900">Past programs</h2>
      <ul className="flex flex-col gap-2">
        {programs.map((program) => (
          <li key={program.id}>
            <Link
              href={`/portal/programs/${program.id}`}
              className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 transition hover:bg-slate-50"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-semibold text-slate-900">
                  {program.name}
                </span>
                <span className="text-xs text-slate-500">
                  Assigned{" "}
                  {new Date(program.assigned_at).toLocaleDateString()}
                </span>
              </span>
              <span aria-hidden className="shrink-0 text-slate-400">
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
