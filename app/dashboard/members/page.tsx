import Link from "next/link";
import { requireStaff } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import type { MemberRow } from "@/lib/members";

export const dynamic = "force-dynamic";

/**
 * Staff member list (mvp-member-management-001). The query carries no tenant
 * predicate — RLS (`member_staff_all`) scopes it to the staff member's gym, so
 * only the current gym's members can ever appear.
 */
export default async function MembersPage() {
  const session = await requireStaff();

  const members = await withTenantContext(session.identity, async (c) => {
    const { rows } = await c.query<MemberRow>(
      `select id, email, full_name, status, auth_user_id, created_at, updated_at
         from member
        order by full_name asc`,
    );
    return rows;
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold">Members</h1>
          <p className="text-sm text-slate-600">
            People at your gym who can be assigned training programs.
          </p>
        </div>
        <Link
          href="/dashboard/members/new"
          className="inline-flex shrink-0 items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-dark"
        >
          Add member
        </Link>
      </div>

      {members.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          No members yet. Add your first member to get started.
        </div>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {members.map((m) => (
            <li key={m.id}>
              <Link
                href={`/dashboard/members/${m.id}`}
                className="flex items-center justify-between gap-4 px-4 py-3 transition hover:bg-slate-50"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium text-slate-900">
                    {m.full_name}
                  </span>
                  <span className="truncate text-sm text-slate-500">
                    {m.email ?? "No email"}
                  </span>
                </div>
                <span className="flex shrink-0 items-center gap-2">
                  {m.auth_user_id ? (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                      Portal active
                    </span>
                  ) : null}
                  <span
                    className={
                      m.status === "active"
                        ? "rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
                        : "rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
                    }
                  >
                    {m.status}
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
