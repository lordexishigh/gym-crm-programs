import { withTenantContext, type Identity } from "./db";

/**
 * Dashboard overview counts (review-hardening-dashboard-001).
 *
 * Pulled out of `app/dashboard/page.tsx` into its own module so the query is a
 * SHARED SQL constant the page and its test both use — the same
 * page/test-cannot-drift pattern as `RECENT_WORKOUTS_SQL`
 * (`lib/workout-logs.ts`) and `rosterListSql` (`lib/members.ts`). Every count
 * runs as the RLS-bound `app_user` role inside `withTenantContext`, so the
 * numbers are the caller's own gym by construction — no query carries a
 * tenant predicate.
 */
export type OverviewStats = {
  members: number;
  activeMembers: number;
  programs: number;
  activeAssignments: number;
  pendingSuggestions: number;
};

/** One round trip; every sub-select is RLS-scoped to the caller's tenant. */
export const DASHBOARD_STATS_SQL = `select
       (select count(*) from member) as members,
       (select count(*) from member where status = 'active') as active_members,
       (select count(*) from program) as programs,
       (select count(*) from program_assignment where status = 'active') as active_assignments,
       (select count(*) from suggestions where status = 'pending') as pending_suggestions`;

/** Live tenant-scoped overview counts for the staff dashboard's KPI row. */
export async function dashboardOverviewStats(
  identity: Identity,
): Promise<OverviewStats> {
  return withTenantContext<OverviewStats>(identity, async (c) => {
    const { rows } = await c.query<{
      members: string;
      active_members: string;
      programs: string;
      active_assignments: string;
      pending_suggestions: string;
    }>(DASHBOARD_STATS_SQL);
    const r = rows[0];
    return {
      members: Number(r?.members ?? 0),
      activeMembers: Number(r?.active_members ?? 0),
      programs: Number(r?.programs ?? 0),
      activeAssignments: Number(r?.active_assignments ?? 0),
      pendingSuggestions: Number(r?.pending_suggestions ?? 0),
    };
  });
}
