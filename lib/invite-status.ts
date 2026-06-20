import { isInviteExpired } from "./invites";

/**
 * Invite lifecycle status helpers (alpha-invite-lifecycle-001).
 *
 * The invite row's stored `status` is the source of truth for the terminal
 * states staff drive explicitly — `accepted` (set at acceptance) and `revoked`
 * (set when staff revoke). Time-based expiry is different: nothing flips a row
 * to `expired` on its own, so a still-`pending` row whose `expires_at` has
 * passed is, in effect, expired even though the column hasn't caught up.
 *
 * `effectiveInviteStatus` resolves that for DISPLAY (pure, unit-testable), and
 * `expireStalePendingInvites` performs the matching DB sweep so the stored
 * status actually updates — keeping the two in agreement.
 */

export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

const TERMINAL: ReadonlySet<string> = new Set([
  "accepted",
  "revoked",
  "expired",
]);

/**
 * The status to show for an invite. A `pending` row past its expiry reads as
 * `expired`; terminal statuses are returned as-is. `now` is injectable for
 * testing.
 */
export function effectiveInviteStatus(
  status: string,
  expiresAt: Date | string | null,
  now: Date = new Date(),
): InviteStatus {
  if (status === "pending") {
    return isInviteExpired(expiresAt, now) ? "expired" : "pending";
  }
  if (TERMINAL.has(status)) return status as InviteStatus;
  // Unknown/legacy value — treat as unusable rather than offering actions on it.
  return "expired";
}

/**
 * SQL that flips every still-`pending` invite whose expiry has passed to
 * `expired`. Tenant scoping is handled by RLS when run inside
 * `withTenantContext`; it carries no tenant predicate of its own.
 */
export const EXPIRE_STALE_INVITES_SQL =
  "update invite set status = 'expired' " +
  "where status = 'pending' and expires_at is not null and expires_at <= now()";

/**
 * Lazily bring stored invite statuses in line with real time: any pending
 * invite past its expiry becomes `expired`. Idempotent and best run inside the
 * caller's existing `withTenantContext` transaction so it shares RLS scope.
 */
export async function expireStalePendingInvites(client: {
  query: (sql: string) => Promise<unknown>;
}): Promise<void> {
  await client.query(EXPIRE_STALE_INVITES_SQL);
}
