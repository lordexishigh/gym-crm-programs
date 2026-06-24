import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import type { MemberRow } from "@/lib/members";
import {
  effectiveInviteStatus,
  expireStalePendingInvites,
} from "@/lib/invite-status";
import {
  MEMBER_STATUS_HISTORY_SQL,
  type MemberStatusEvent,
} from "@/lib/member-records";
import { memberAdherence, recentWorkoutLogs } from "@/lib/workout-logs";
import { MemberForm } from "../MemberForm";
import { StatusHistory } from "../StatusHistory";
import { WorkoutAdherence } from "../WorkoutAdherence";
import { updateMemberAction } from "../actions";
import { InvitePanel } from "../InvitePanel";
import { GdprPanel } from "../GdprPanel";

export const dynamic = "force-dynamic";

type LastInvite = { id: string; status: string; expires_at: string | null };

/**
 * Member detail / edit screen (mvp-member-management-001/003). Loads the member
 * and their most recent invite under RLS — a cross-tenant id resolves to no row
 * and 404s. Shows the edit form plus the portal-invite control.
 */
export default async function MemberDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireStaff();

  const data = await withTenantContext(session.identity, async (c) => {
    const member = (
      await c.query<MemberRow & { erased_at: string | null }>(
        `select id, email, full_name, phone, status, notes,
                auth_user_id, created_at, updated_at, erased_at
           from member where id = $1`,
        [id],
      )
    ).rows[0];
    if (!member) return null;

    // Keep stored statuses honest before reading the latest invite.
    await expireStalePendingInvites(c);

    const lastInvite = (
      await c.query<LastInvite>(
        `select id, status, expires_at from invite
          where member_id = $1
          order by created_at desc
          limit 1`,
        [id],
      )
    ).rows[0] ?? null;

    // Shared SQL (lib/member-records) so this read can't drift from the helper.
    const statusHistory = (
      await c.query<MemberStatusEvent>(MEMBER_STATUS_HISTORY_SQL, [id])
    ).rows;

    return { member, lastInvite, statusHistory };
  });

  if (!data) notFound();
  const { member, lastInvite, statusHistory } = data;

  // Training-adherence signal (ga-trainer-insights-001): read-only for staff,
  // tenant-scoped by the `workout_log_staff_select` RLS policy.
  const [adherence, workouts] = await Promise.all([
    memberAdherence(session.identity, member.id),
    recentWorkoutLogs(session.identity, member.id),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href="/dashboard/members"
          className="text-sm font-medium text-slate-500 hover:text-slate-700"
        >
          ← Members
        </Link>
        <h1 className="text-2xl font-bold">{member.full_name}</h1>
      </div>

      <dl className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Email
          </dt>
          <dd className="text-slate-900">{member.email ?? "—"}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Phone
          </dt>
          <dd className="text-slate-900">{member.phone ?? "—"}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Status
          </dt>
          <dd className="text-slate-900">{member.status}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Portal access
          </dt>
          <dd className="text-slate-900">
            {member.auth_user_id ? "Active" : "Not set up"}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5 sm:col-span-2">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Notes
          </dt>
          <dd className="whitespace-pre-wrap text-slate-900">
            {member.notes ?? "—"}
          </dd>
        </div>
      </dl>

      <MemberForm
        action={updateMemberAction}
        submitLabel="Save changes"
        defaults={{
          id: member.id,
          fullName: member.full_name,
          email: member.email ?? "",
          phone: member.phone ?? "",
          status: member.status,
          notes: member.notes ?? "",
        }}
      />

      <WorkoutAdherence adherence={adherence} logs={workouts} />

      <StatusHistory events={statusHistory} />

      <InvitePanel
        memberId={member.id}
        hasEmail={Boolean(member.email)}
        alreadyActive={Boolean(member.auth_user_id)}
        lastInvite={
          lastInvite
            ? {
                id: lastInvite.id,
                // Show the effective status so a just-expired pending invite
                // reads as "expired", matching the invites dashboard.
                status: effectiveInviteStatus(
                  lastInvite.status,
                  lastInvite.expires_at,
                ),
                expiresAt: lastInvite.expires_at,
              }
            : null
        }
      />

      <GdprPanel memberId={member.id} erased={Boolean(member.erased_at)} />
    </div>
  );
}
