import Link from "next/link";
import { requireStaff } from "@/lib/auth/session";
import { ImportWizard } from "./ImportWizard";

export const dynamic = "force-dynamic";

/**
 * Bulk member import screen (market gap: adoption).
 *
 * Lives under `/dashboard/members/` so the dashboard layout's `requireStaff`
 * guard covers it, and calls `requireStaff` itself as well — the page must never
 * depend on a parent layout for its authorisation. All writing happens in the
 * Server Action; there is deliberately no public bulk-insert API route.
 */
export default async function ImportMembersPage() {
  await requireStaff();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href="/dashboard/members"
          className="text-sm font-medium text-slate-500 hover:text-slate-700"
        >
          ← Members
        </Link>
        <h1 className="text-2xl font-bold">Import members</h1>
        <p className="text-sm text-slate-600">
          Bring your whole roster over from another system in one go — no
          re-typing.
        </p>
      </div>

      <ImportWizard />
    </div>
  );
}
