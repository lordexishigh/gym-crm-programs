import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import { getStaffRole } from "@/lib/staff";
import type { MemberRow, MembershipStatus } from "@/lib/members";
import {
  effectiveInviteStatus,
  expireStalePendingInvites,
} from "@/lib/invite-status";
import {
  MEMBER_STATUS_HISTORY_SQL,
  type MemberStatusEvent,
} from "@/lib/member-records";
import { memberAdherence, recentWorkoutLogs } from "@/lib/workout-logs";
import type { MembershipPlanRow, MemberPlanWithPlan } from "@/lib/plans";
import { MemberForm } from "../MemberForm";
import { StatusHistory } from "../StatusHistory";
import { WorkoutAdherence } from "../WorkoutAdherence";
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
  const session = await requireStaff();

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
  const [adherence, workouts, staffRole] = await Promise.all([
    memberAdherence(session.identity, member.id),
    recentWorkoutLogs(session.identity, member.id),
    getStaffRole(session.identity),
  ]);

  // Billing data is owner-only (issue: staff role separation) — a trainer
  // never even queries plans/subscriptions, let alone sees them rendered.
  const billing =
    staffRole === "owner"
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        {member.photo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={member.photo_url}
            alt={`${member.full_name} profile photo`}
            className="h-14 w-14 shrink-0 rounded-full object-cover ring-1 ring-slate-200"
          />
        ) : (
          <span
            aria-hidden
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-slate-100 text-lg font-semibold text-slate-500 ring-1 ring-slate-200"
          >
            {member.full_name.charAt(0).toUpperCase()}
          </span>
        )}
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

      <WorkoutAdherence adherence={adherence} logs={workouts} />

      {billing ? (
        <BillingPanel
          memberId={member.id}
          plans={billing.plans}
          subscriptions={billing.subscriptions}
        />
      ) : null}

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
