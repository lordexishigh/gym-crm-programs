import Link from "next/link";
import { requireStaff } from "@/lib/auth/session";
import { dashboardOverviewStats } from "@/lib/dashboard";
import { currentOccupancy } from "@/lib/checkin";
import { CapabilityNotice } from "@/app/components/CapabilityNotice";

export const dynamic = "force-dynamic";

/**
 * Dashboard overview (review-hardening-dashboard-001).
 *
 * The layout already gates access; calling `requireStaff` here too keeps the
 * page self-contained. Shows at-a-glance KPIs for the gym (live, tenant-scoped
 * counts) above quick navigational shortcuts into each section.
 */
export default async function DashboardPage() {
  const session = await requireStaff();

  const stats = await dashboardOverviewStats(session.identity);

  // Live occupancy is its own read (a different table, and a rolling time
  // window rather than a tenant count), so it stays out of the KPI round trip.
  const occupancy = await currentOccupancy(session.identity);

  const kpis = [
    {
      label: "Members",
      value: stats.members,
      hint: `${stats.activeMembers} active`,
      href: "/dashboard/members",
      icon: IconUsers,
    },
    {
      label: "Programs",
      value: stats.programs,
      hint: "Training plans built",
      href: "/dashboard/programs",
      icon: IconClipboard,
    },
    {
      label: "Active assignments",
      value: stats.activeAssignments,
      hint: "Programs in members' hands",
      href: "/dashboard/programs",
      icon: IconSparkles,
    },
    // Replaces the old "Active members" tile, which restated the two numbers
    // the "Members" tile already shows (total, with "N active" as its hint) and
    // read as live presence when it meant membership STATUS — the exact
    // misreading this feedback round reported. This tile is the real live
    // number: who is physically in the building, from check-in/check-out.
    {
      label: "In the gym now",
      value: occupancy,
      hint: "Checked in, not yet out",
      href: "/dashboard/checkin",
      icon: IconPulse,
    },
  ];

  const actions = [
    // First, and conditional: a pending brief is time-sensitive in a way that
    // "add a member" is not — it names a member who has already stopped
    // training, and the value of contacting them decays daily. Hidden entirely
    // when the queue is empty rather than shown as a zero, so it reads as work
    // waiting rather than as a permanent fixture.
    ...(stats.pendingSuggestions > 0
      ? [
          {
            label: `Review ${stats.pendingSuggestions} suggestion${stats.pendingSuggestions === 1 ? "" : "s"}`,
            hint: "Members who have gone quiet, with the evidence",
            href: "/dashboard/suggestions",
            icon: IconPulse,
          },
        ]
      : []),
    {
      label: "Add a member",
      hint: "Create a member and invite them to the portal",
      href: "/dashboard/members/new",
      icon: IconUserPlus,
    },
    {
      label: "Build a program",
      hint: "Compose exercises into a training plan",
      href: "/dashboard/programs/new",
      icon: IconClipboard,
    },
    {
      label: "Manage invites",
      hint: "Track and resend portal invitations",
      href: "/dashboard/invites",
      icon: IconMail,
    },
  ];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Overview</h1>
        <p className="text-sm text-slate-600">
          Welcome back. Build training programs and assign them to your members.
        </p>
      </div>

      {/* Deployment gaps, if any — see the component for why this is here. */}
      <CapabilityNotice />

      {/* KPI row */}
      <section aria-label="Gym at a glance">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {kpis.map((kpi) => {
            const Icon = kpi.icon;
            return (
              <Link
                key={kpi.label}
                href={kpi.href}
                className="group flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-5 transition hover:border-brand hover:-translate-y-0.5"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand transition group-hover:bg-brand/20">
                  <Icon />
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-3xl font-bold tracking-tight text-slate-900 tabular-nums">
                    {kpi.value.toLocaleString()}
                  </span>
                  <span className="text-sm font-medium text-slate-700">
                    {kpi.label}
                  </span>
                  <span className="text-xs text-slate-500">{kpi.hint}</span>
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Quick actions */}
      <section aria-label="Quick actions" className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Quick actions
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <Link
                key={action.label}
                href={action.href}
                className="group flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-brand hover:-translate-y-0.5"
              >
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand transition group-hover:bg-brand/20">
                  <Icon />
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-semibold text-slate-900">
                    {action.label}
                  </span>
                  <span className="text-sm text-slate-500">{action.hint}</span>
                </span>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Inline, decorative icons (aria-hidden). Stroke = currentColor so they take
 * the brand tint from their container. Kept tiny and inline to avoid pulling in
 * an icon dependency that would weigh on the mobile bundle/LCP budget.
 * ------------------------------------------------------------------------- */
const iconProps = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function IconUsers() {
  return (
    <svg {...iconProps}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconClipboard() {
  return (
    <svg {...iconProps}>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M9 12h6M9 16h6" />
    </svg>
  );
}

function IconSparkles() {
  return (
    <svg {...iconProps}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="m6.3 6.3 2.4 2.4M15.3 15.3l2.4 2.4M17.7 6.3l-2.4 2.4M8.7 15.3l-2.4 2.4" />
    </svg>
  );
}

function IconPulse() {
  return (
    <svg {...iconProps}>
      <path d="M3 12h4l2 7 4-14 2 7h6" />
    </svg>
  );
}

function IconUserPlus() {
  return (
    <svg {...iconProps}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M19 8v6M22 11h-6" />
    </svg>
  );
}

function IconMail() {
  return (
    <svg {...iconProps}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m2 7 10 6 10-6" />
    </svg>
  );
}
