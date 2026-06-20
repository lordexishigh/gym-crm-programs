import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import type { MemberRow } from "@/lib/members";
import { MemberForm } from "../MemberForm";
import { updateMemberAction } from "../actions";
import { InvitePanel } from "../InvitePanel";

export const dynamic = "force-dynamic";

type LastInvite = { status: string; expires_at: string | null };

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
      await c.query<MemberRow>(
        `select id, email, full_name, status, auth_user_id, created_at, updated_at
           from member where id = $1`,
        [id],
      )
    ).rows[0];
    if (!member) return null;

    const lastInvite = (
      await c.query<LastInvite>(
        `select status, expires_at from invite
          where member_id = $1
          order by created_at desc
          limit 1`,
        [id],
      )
    ).rows[0] ?? null;

    return { member, lastInvite };
  });

  if (!data) notFound();
  const { member, lastInvite } = data;

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

      <MemberForm
        action={updateMemberAction}
        submitLabel="Save changes"
        defaults={{
          id: member.id,
          fullName: member.full_name,
          email: member.email ?? "",
          status: member.status,
        }}
      />

      <InvitePanel
        memberId={member.id}
        hasEmail={Boolean(member.email)}
        alreadyActive={Boolean(member.auth_user_id)}
        lastInvite={
          lastInvite
            ? { status: lastInvite.status, expiresAt: lastInvite.expires_at }
            : null
        }
      />
    </div>
  );
}
