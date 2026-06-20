import { requireStaff } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Dashboard overview. The layout already gates access; calling `requireStaff`
 * here too keeps the page self-contained and gives us the session identity.
 */
export default async function DashboardPage() {
  const session = await requireStaff();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Overview</h1>
        <p className="text-sm text-slate-600">
          Welcome back. Build training programs and assign them to your members.
        </p>
      </div>

      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          { label: "Members", hint: "Invite and manage members" },
          { label: "Programs", hint: "Create training programs" },
          { label: "Assignments", hint: "Assign programs to members" },
        ].map((card) => (
          <div
            key={card.label}
            className="rounded-xl border border-slate-200 bg-white p-4"
          >
            <dt className="text-sm font-semibold text-slate-900">{card.label}</dt>
            <dd className="mt-1 text-sm text-slate-500">{card.hint}</dd>
          </div>
        ))}
      </dl>

      <p className="text-xs text-slate-400">
        Signed in to tenant {session.identity.tenantId}.
      </p>
    </div>
  );
}
