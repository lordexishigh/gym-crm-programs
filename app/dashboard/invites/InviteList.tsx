import Link from "next/link";
import type { ReactNode } from "react";
import {
  effectiveInviteStatus,
  type InviteStatus,
} from "../../../lib/invite-status";

/**
 * Pure presentational invite list (alpha-invite-lifecycle-001/002).
 *
 * Owns the staff-facing display: per-row status is derived with
 * `effectiveInviteStatus` (a still-`pending` row past its expiry shows as
 * `expired`), and rows are visibly separated by a status badge plus the
 * per-status count chips. Resend/revoke controls are injected via `renderActions`
 * so this component never imports the server-action module — that keeps it
 * renderable in the view test exactly like `ProgramHistory` (relative imports,
 * no DB/session, no `@/` alias).
 */

/** A single invite as read by the dashboard (tenant-scoped via RLS). */
export type InviteListRow = {
  id: string;
  email: string;
  status: string;
  expires_at: string | null;
  created_at: string;
  accepted_at: string | null;
  member_id: string | null;
  member_name: string | null;
  member_auth_user_id: string | null;
  /** Email delivery state from Resend webhooks (beta-hardening-002). Optional
   *  so the pure view test can omit it; absent/'pending'/'sent'/'delivered'
   *  show no warning. */
  delivery_status?: string | null;
  delivery_detail?: string | null;
};

/** Delivery states that represent a deliverability problem worth flagging. */
const DELIVERY_PROBLEM: Record<string, string> = {
  bounced: "Bounced",
  complained: "Marked as spam",
  failed: "Delivery failed",
  delayed: "Delivery delayed",
};

/** A row annotated with its display status, as passed to `renderActions`. */
export type InviteView = InviteListRow & { effective: InviteStatus };

const BADGE: Record<InviteStatus, string> = {
  pending: "bg-amber-50 text-amber-700",
  accepted: "bg-emerald-50 text-emerald-700",
  revoked: "bg-slate-100 text-slate-600",
  expired: "bg-rose-50 text-rose-700",
};

function fmtDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : "—";
}

export function InviteList({
  invites,
  renderActions,
}: {
  invites: InviteListRow[];
  /** Renders the resend/revoke controls for a row (omitted in the view test). */
  renderActions?: (row: InviteView) => ReactNode;
}) {
  const view: InviteView[] = invites.map((row) => ({
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
    <div className="flex flex-col gap-4">
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
          No invites yet. Use &ldquo;Invite a member&rdquo; above to send the
          first one.
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
                {row.delivery_status && DELIVERY_PROBLEM[row.delivery_status] ? (
                  <span
                    className="mt-0.5 inline-flex w-fit items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700"
                    title={row.delivery_detail ?? undefined}
                  >
                    ⚠ {DELIVERY_PROBLEM[row.delivery_status]}
                  </span>
                ) : null}
              </div>

              {renderActions ? renderActions(row) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
