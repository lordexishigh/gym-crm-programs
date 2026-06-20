import Link from "next/link";
import { requireStaff } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import {
  ROSTER_PAGE_SIZE,
  memberRosterWhere,
  parseRosterFilters,
  rosterPageCount,
  type MemberRow,
  type RosterFilters,
} from "@/lib/members";

export const dynamic = "force-dynamic";

/** Build a roster URL preserving the current search/filter, on a given page. */
function rosterHref(filters: RosterFilters, page: number): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.status !== "all") params.set("status", filters.status);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/dashboard/members?${qs}` : "/dashboard/members";
}

/**
 * Staff member roster (alpha-member-records-002). Server-side search by name,
 * filter by status, and pagination. No query carries a tenant predicate — RLS
 * (`member_staff_all`) scopes every row to the staff member's gym.
 */
export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const session = await requireStaff();
  const filters = parseRosterFilters(await searchParams);

  const { members, total } = await withTenantContext(
    session.identity,
    async (c) => {
      const { clause, params } = memberRosterWhere(filters);

      const total = Number(
        (
          await c.query<{ count: string }>(
            `select count(*)::text as count from member ${clause}`,
            params,
          )
        ).rows[0]?.count ?? "0",
      );

      // Clamp the requested page to the available range, then page the rows.
      const pageCount = rosterPageCount(total);
      const page = Math.min(filters.page, pageCount);
      const offset = (page - 1) * ROSTER_PAGE_SIZE;

      const { rows } = await c.query<MemberRow>(
        `select id, email, full_name, phone, status, notes,
                auth_user_id, created_at, updated_at
           from member ${clause}
          order by full_name asc
          limit $${params.length + 1} offset $${params.length + 2}`,
        [...params, ROSTER_PAGE_SIZE, offset],
      );

      return { members: rows, total };
    },
  );

  const pageCount = rosterPageCount(total);
  const page = Math.min(filters.page, pageCount);
  const filtering = filters.q !== "" || filters.status !== "all";

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

      {/* Search + filter. A plain GET form keeps state in the URL (shareable,
          back-button friendly) and re-runs the server query. */}
      <form
        method="get"
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
      >
        <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-slate-700">
          Search by name
          <input
            type="search"
            name="q"
            defaultValue={filters.q}
            placeholder="Jane Athlete"
            className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Status
          <select
            name="status"
            defaultValue={filters.status}
            className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-dark"
          >
            Search
          </button>
          {filtering ? (
            <Link
              href="/dashboard/members"
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              Clear
            </Link>
          ) : null}
        </div>
      </form>

      {members.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          {filtering
            ? "No members match your search."
            : "No members yet. Add your first member to get started."}
        </div>
      ) : (
        <>
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

          <div className="flex items-center justify-between gap-4 text-sm text-slate-600">
            <span>
              {total} member{total === 1 ? "" : "s"} · page {page} of {pageCount}
            </span>
            <span className="flex items-center gap-2">
              {page > 1 ? (
                <Link
                  href={rosterHref(filters, page - 1)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  ← Prev
                </Link>
              ) : null}
              {page < pageCount ? (
                <Link
                  href={rosterHref(filters, page + 1)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  Next →
                </Link>
              ) : null}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
