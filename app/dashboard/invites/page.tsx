import Link from "next/link";
import { requireStaff } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import {
  effectiveInviteStatus,
  expireStalePendingInvites,
  type InviteStatus,
} from "@/lib/invite-status";
import { InviteRowActions } from "./InviteRowActions";

export const dynamic = "force-dynamic";

/**
 * Staff invite-lifecycle view (alpha-invite-lifecycle-001/002).
 *
 * Lists every invite in the gym with an ACCURATE status: a lazy sweep first
 * flips any pending-but-past-expiry rows to `expired` (so the stored status
 * matches reality), and `effectiveInviteStatus` is used for display as a
 * belt-and-braces guard. The query carries no tenant predicate — RLS
 * (`invite_staff_all`) scopes it to the staff member's own gym.
 */

type InviteRow = {
  id: string;
  email: string;
  status: string;
  expires_at: string | null;
  created_at: string;
  accepted_at: string | null;
  member_id: string | null;
  member_name: string | null;
  member_auth_user_id: string | null;
};

const BADGE: Record<InviteStatus, string> = {
  pending: "bg-amber-50 text-amber-700",
  accepted: "bg-emerald-50 text-emerald-700",
  revoked: "bg-slate-100 text-slate-600",
  expired: "bg-rose-50 text-rose-700",
};

function fmtDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : "—";
}

export default async function InvitesPage() {
  const session = await requireStaff();

  const invites = await withTenantContext(session.identity, async (c) => {
    // Bring stored statuses in line with real time before reading them.
    await expireStalePendingInvites(c);

    const { rows } = await c.query<InviteRow>(
      `select i.id, i.email, i.status, i.expires_at, i.created_at, i.accepted_at,
              i.member_id,
              m.full_name    as member_name,
              m.auth_user_id as member_auth_user_id
         from invite i
         left join member m
           on m.id = i.member_id and m.tenant_id = i.tenant_id
        order by i.created_at desc`,
    );
    return rows;
  });

  const view = invites.map((row) => ({
    ...row,
    effective: effectiveInviteStatus(row.status, row.expires_at),
  }));

  const counts = view.reduce<Record<InviteStatus, number>>(
    (acc, r) => {
      acc[r.effective] += 1;
      return acc;
    },
    { pending: 0, accepted: 0, revoked: 0, expired: 0 },
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Invites</h1>
        <p className="text-sm text-slate-600">
          Portal invites across your gym. Resend a stale invite or revoke one
          that should no longer work.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full bg-amber-50 px-2.5 py-1 font-medium text-amber-700">
          {counts.pending} pending
        </span>
        <span className="rounded-full bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700">
          {counts.accepted} accepted
        </span>
        <span className="rounded-full bg-rose-50 px-2.5 py-1 font-medium text-rose-700">
          {counts.expired} expired
        </span>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-600">
          {counts.revoked} revoked
        </span>
      </div>

      {view.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          No invites yet. Invite a member from their detail page to get started.
        </div>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {view.map((row) => (
            <li
              key={row.id}
              className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  {row.member_id ? (
                    <Link
                      href={`/dashboard/members/${row.member_id}`}
                      className="truncate font-medium text-slate-900 hover:underline"
                    >
                      {row.member_name ?? row.email}
                    </Link>
                  ) : (
                    <span className="truncate font-medium text-slate-900">
                      {row.member_name ?? row.email}
                    </span>
                  )}
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[row.effective]}`}
                  >
                    {row.effective}
                  </span>
                </span>
                <span className="truncate text-xs text-slate-500">
                  {row.email}
                  {" · "}
                  {row.effective === "accepted"
                    ? `accepted ${fmtDate(row.accepted_at)}`
                    : row.effective === "pending"
                      ? `expires ${fmtDate(row.expires_at)}`
                      : `sent ${fmtDate(row.created_at)}`}
                </span>
              </div>

              <InviteRowActions
                inviteId={row.id}
                memberId={row.member_id}
                // Re-inviting an already-active member is pointless; otherwise a
                // pending/expired/revoked invite can be re-sent fresh.
                canResend={
                  !row.member_auth_user_id && row.effective !== "accepted"
                }
                canRevoke={row.effective === "pending"}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
