import { withTenantContext, type Identity } from "./db";
import type { MemberStatus } from "./members";

/**
 * Member status-history read path (alpha-member-records-001).
 *
 * The single source of truth for the "edit history of status" query the member
 * detail view shows, shared by the detail page (`app/dashboard/members/[id]`)
 * and any test so the two can never drift — the same convention as the read
 * helpers in lib/portal.ts. Kept out of lib/members.ts so that module stays a
 * PURE (no-DB) validation/roster-shaping unit.
 *
 * Isolation is enforced by RLS: the `status_event_staff_all` policy
 * (migration 0003) scopes every row to the signed-in staff member's gym, so the
 * query filters only by `member_id` and never needs `where tenant_id = …`.
 */

/** One status change as rendered by the detail view (author resolved via join). */
export type MemberStatusEvent = {
  /** Null for the very first (member-creation) event. */
  old_status: MemberStatus | null;
  new_status: MemberStatus;
  changed_at: string;
  /** The staff author's name, or null when unknown / since-removed. */
  changed_by_name: string | null;
};

/** The status-history query, kept in one place to prevent drift. */
export const MEMBER_STATUS_HISTORY_SQL = `select e.old_status, e.new_status, e.changed_at,
        u.full_name as changed_by_name
   from member_status_event e
   left join users u on u.id = e.changed_by
  where e.member_id = $1
  order by e.changed_at desc`;

/**
 * Resolve a member's status history, newest first. RLS constrains the result to
 * the caller's own gym regardless of the `memberId` argument.
 */
export async function memberStatusHistory(
  identity: Identity,
  memberId: string,
): Promise<MemberStatusEvent[]> {
  return withTenantContext(
    identity,
    async (c) =>
      (await c.query<MemberStatusEvent>(MEMBER_STATUS_HISTORY_SQL, [memberId]))
        .rows,
  );
}
