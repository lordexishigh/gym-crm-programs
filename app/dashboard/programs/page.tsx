import Link from "next/link";
import { requireStaff } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";

export const dynamic = "force-dynamic";

type ProgramListRow = {
  id: string;
  name: string;
  description: string | null;
  exercise_count: number;
  assignment_count: number;
};

/**
 * Staff program list (mvp-program-002). The query carries no tenant predicate —
 * RLS (`program_staff_all`) scopes it to the staff member's gym, so only the
 * current gym's programs can ever appear. Exercise/assignment counts come from
 * tenant-scoped subqueries (also RLS-bound).
 */
export default async function ProgramsPage() {
  const session = await requireStaff();

  const programs = await withTenantContext(session.identity, async (c) => {
    const { rows } = await c.query<ProgramListRow>(
      `select
         p.id,
         p.name,
         p.description,
         (select count(*) from exercise e where e.program_id = p.id)::int
           as exercise_count,
         (select count(*) from program_assignment a
            where a.program_id = p.id and a.status = 'active')::int
           as assignment_count
       from program p
       order by p.name asc`,
    );
    return rows;
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold">Programs</h1>
          <p className="text-sm text-slate-600">
            Training programs you build and assign to members.
          </p>
        </div>
        <Link
          href="/dashboard/programs/new"
          className="inline-flex shrink-0 items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-dark"
        >
          New program
        </Link>
      </div>

      {programs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          No programs yet. Build your first program to assign to members.
        </div>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {programs.map((p) => (
            <li key={p.id}>
              <Link
                href={`/dashboard/programs/${p.id}`}
                className="flex items-center justify-between gap-4 px-4 py-3 transition hover:bg-slate-50"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium text-slate-900">
                    {p.name}
                  </span>
                  <span className="truncate text-sm text-slate-500">
                    {p.description ?? "No description"}
                  </span>
                </div>
                <span className="flex shrink-0 items-center gap-2 text-xs text-slate-600">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium">
                    {p.exercise_count}{" "}
                    {p.exercise_count === 1 ? "exercise" : "exercises"}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium">
                    {p.assignment_count} assigned
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
