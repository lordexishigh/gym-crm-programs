import Link from "next/link";
import { requireStaff } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Dashboard overview. The layout already gates access; calling `requireStaff`
 * here too keeps the page self-contained.
 *
 * The cards are navigable shortcuts into each section. Live tenant-scoped counts
 * are scheduled as review-hardening-dashboard-001 (see docs/PLAN.md).
 */
export default async function DashboardPage() {
  await requireStaff();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Overview</h1>
        <p className="text-sm text-slate-600">
          Welcome back. Build training programs and assign them to your members.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          { label: "Members", hint: "Invite and manage members", href: "/dashboard/members" },
          { label: "Programs", hint: "Create training programs", href: "/dashboard/programs" },
          { label: "Assignments", hint: "Assign programs to members", href: "/dashboard/programs" },
        ].map((card) => (
          <Link
            key={card.label}
            href={card.href}
            className="rounded-xl border border-slate-200 bg-white p-4 transition hover:border-brand"
          >
            <span className="block text-sm font-semibold text-slate-900">
              {card.label}
            </span>
            <span className="mt-1 block text-sm text-slate-500">{card.hint}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
