import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import { staffCan } from "@/lib/permissions";
import { memberAttendance } from "@/lib/checkin";
import type { MemberRow, MembershipStatus } from "@/lib/members";
import {
  effectiveInviteStatus,
  expireStalePendingInvites,
} from "@/lib/invite-status";
import {
  MEMBER_ASSIGNMENT_HISTORY_SQL,
  MEMBER_INVITE_HISTORY_SQL,
  MEMBER_STATUS_HISTORY_SQL,
  type MemberAssignmentEvent,
  type MemberInviteEvent,
  type MemberStatusEvent,
} from "@/lib/member-records";
import { buildMemberTimeline } from "@/lib/timeline";
import { memberAdherence, recentWorkoutLogs } from "@/lib/workout-logs";
import type { MembershipPlanRow, MemberPlanWithPlan } from "@/lib/plans";
import { memberAvatarSrc } from "@/lib/member-photo";
import { memberTasks } from "@/lib/member-tasks";
import { Avatar } from "@/app/components/Avatar";
import { MemberForm } from "../MemberForm";
import { MemberPhotoPanel } from "../MemberPhotoPanel";
import { Attendance } from "../Attendance";
import { Timeline } from "../Timeline";
import { WorkoutAdherence } from "../WorkoutAdherence";
import { MemberTasks } from "../MemberTasks";
import { updateMemberAction, regeneratePinAction } from "../actions";
import { InvitePanel } from "../InvitePanel";
import { GdprPanel } from "../GdprPanel";
import { BillingPanel } from "./BillingPanel";

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
  const session = await requireCapability("members.read");

  const data = await withTenantContext(session.identity, async (c) => {
    const member = (
      await c.query<MemberRow & { erased_at: string | null; pin_code: string | null }>(
        `select id, email, full_name, phone, status, notes,
                auth_user_id, photo_url, emergency_contact_name,
                emergency_contact_phone, membership_status, pin_code,
                created_at, updated_at, erased_at
           from member where id = $1`,
        [id],
      )
    ).rows[0];
    if (!member) return null;

    // Photo PRESENCE only — the bytes live in their own table (0019) and are
    // streamed by /api/members/[id]/photo, never pulled into a page render.
    const photoUpdatedAt =
      (
        await c.query<{ updated_at: Date }>(
          "select updated_at from member_photo where member_id = $1",
          [id],
        )
      ).rows[0]?.updated_at ?? null;

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
    const assignmentHistory = (
      await c.query<MemberAssignmentEvent>(MEMBER_ASSIGNMENT_HISTORY_SQL, [id])
    ).rows;
    const inviteHistory = (
      await c.query<MemberInviteEvent>(MEMBER_INVITE_HISTORY_SQL, [id])
    ).rows;

    return {
      member,
      lastInvite,
      statusHistory,
      assignmentHistory,
      inviteHistory,
      photoUpdatedAt,
    };
  });

  if (!data) notFound();
  const {
    member,
    lastInvite,
    statusHistory,
    assignmentHistory,
    inviteHistory,
    photoUpdatedAt,
  } = data;

  const avatarSrc = memberAvatarSrc({
    id: member.id,
    photo_updated_at: photoUpdatedAt,
    photo_url: member.photo_url,
  });

  // Training-adherence signal (ga-trainer-insights-001): read-only for staff,
  // tenant-scoped by the `workout_log_staff_select` RLS policy. Attendance
  // joins it here because it is the same question asked of a different table —
  // and it is the lookup the Front Desk role exists to perform.
  const [adherence, workouts, attendance, tasks] = await Promise.all([
    memberAdherence(session.identity, member.id),
    recentWorkoutLogs(session.identity, member.id),
    memberAttendance(session.identity, member.id),
    memberTasks(session.identity, member.id),
  ]);

  // Billing data is owner-only (issue: staff role separation) — a trainer or
  // front-desk session never even queries plans/subscriptions, let alone sees
  // them rendered. RLS denies the front desk those tables outright (0026), so
  // this is the guard, not the only one.
  const billing =
    staffCan(session.staffRole, "payments.read")
      ? await withTenantContext(session.identity, async (c) => {
          const plans = (
            await c.query<MembershipPlanRow>(
              `select id, tenant_id, name, tier, price_cents, currency, active,
                      created_at, updated_at
                 from membership_plans
                where active
                order by tier, price_cents`,
            )
          ).rows;
          const subscriptions = (
            await c.query<MemberPlanWithPlan>(
              `select mp.id, mp.tenant_id, mp.member_id, mp.plan_id, mp.status,
                      mp.stripe_customer_id, mp.stripe_subscription_id,
                      mp.stripe_payment_intent_id, mp.payment_retry_count,
                      mp.current_period_end, mp.started_at, mp.cancelled_at,
                      mp.created_at, mp.updated_at,
                      p.name as plan_name, p.tier as plan_tier,
                      p.price_cents as plan_price_cents, p.currency as plan_currency
                 from member_plans mp
                 join membership_plans p on p.id = mp.plan_id
                where mp.member_id = $1
                order by mp.created_at desc`,
              [member.id],
            )
          ).rows;
          return { plans, subscriptions };
        })
      : null;

  const timeline = buildMemberTimeline({
    statusEvents: statusHistory,
    assignmentEvents: assignmentHistory,
    inviteEvents: inviteHistory,
    workoutLogs: workouts,
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <Avatar name={member.full_name} src={avatarSrc} size="md" />
        <div className="flex flex-col gap-1">
          <Link
            href="/dashboard/members"
            className="text-sm font-medium text-slate-500 hover:text-slate-700"
          >
            ← Members
          </Link>
          <h1 className="text-2xl font-bold">{member.full_name}</h1>
        </div>
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
            Membership status
          </dt>
          <dd>
            <MembershipStatusBadge status={member.membership_status} />
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Portal access
          </dt>
          <dd className="text-slate-900">
            {member.auth_user_id ? "Active" : "Not set up"}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Emergency contact
          </dt>
          <dd className="text-slate-900">
            {member.emergency_contact_name || member.emergency_contact_phone
              ? [member.emergency_contact_name, member.emergency_contact_phone]
                  .filter(Boolean)
                  .join(" · ")
              : "—"}
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

      <MemberPhotoPanel
        memberId={member.id}
        memberName={member.full_name}
        photoSrc={avatarSrc}
        hasUpload={photoUpdatedAt !== null}
      />

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
          photoUrl: member.photo_url ?? "",
          emergencyContactName: member.emergency_contact_name ?? "",
          emergencyContactPhone: member.emergency_contact_phone ?? "",
          membershipStatus: member.membership_status,
        }}
      />

      <section className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">
            Check-in PIN
          </h2>
          <p className="font-mono text-2xl font-bold tracking-widest text-slate-900">
            {member.pin_code ?? "—"}
          </p>
        </div>
        <form action={regeneratePinAction}>
          <input type="hidden" name="memberId" value={member.id} />
          <button
            type="submit"
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            {member.pin_code ? "Regenerate" : "Generate PIN"}
          </button>
        </form>
      </section>

      <Attendance attendance={attendance} />

      <WorkoutAdherence adherence={adherence} logs={workouts} />

      {billing ? (
        <BillingPanel
          memberId={member.id}
          plans={billing.plans}
          subscriptions={billing.subscriptions}
        />
      ) : null}

      {/* Follow-ups sit above the timeline: they are the outstanding work on
          this member, where the timeline is the record of what already
          happened. */}
      <MemberTasks memberId={member.id} tasks={tasks} />

      {/* Replaces the standalone StatusHistory panel: status changes,
          assignments, invites and workouts are one chronology, and reading
          them as four separate lists made the order between them invisible. */}
      <Timeline entries={timeline} />

      {/* Portal access and data-subject rights are administrative, not desk
          work: both are hidden from a front-desk session, and their Server
          Actions refuse it independently of what is rendered here. */}
      {staffCan(session.staffRole, "invites.manage") ? (
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
      ) : null}

      {staffCan(session.staffRole, "gdpr.manage") ? (
        <GdprPanel memberId={member.id} erased={Boolean(member.erased_at)} />
      ) : null}
    </div>
  );
}

const MEMBERSHIP_STATUS_STYLES: Record<MembershipStatus, string> = {
  active: "bg-emerald-50 text-emerald-700",
  expired: "bg-red-50 text-red-700",
  frozen: "bg-amber-50 text-amber-700",
  cancelled: "bg-slate-100 text-slate-600",
};

/** Billing/renewal status pill — the safety/renewal signal issue #1 asks for. */
function MembershipStatusBadge({ status }: { status: MembershipStatus }) {
  return (
    <span
      className={`inline-flex w-fit rounded-full px-2 py-0.5 text-xs font-medium capitalize ${MEMBERSHIP_STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}
