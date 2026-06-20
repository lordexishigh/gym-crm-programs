import Link from "next/link";
import { requireStaff } from "@/lib/auth/session";
import { MemberForm } from "../MemberForm";
import { createMemberAction } from "../actions";

export const dynamic = "force-dynamic";

/** Create-member screen (mvp-member-management-001). */
export default async function NewMemberPage() {
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
        <h1 className="text-2xl font-bold">Add member</h1>
      </div>

      <MemberForm action={createMemberAction} submitLabel="Create member" />
    </div>
  );
}
