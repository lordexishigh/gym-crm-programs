import { requireStaff } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import { expireStalePendingInvites } from "@/lib/invite-status";
import { InviteList, type InviteListRow } from "./InviteList";
import { InviteRowActions } from "./InviteRowActions";

export const dynamic = "force-dynamic";

/**
 * Staff invite-lifecycle view (alpha-invite-lifecycle-001/002).
 *
 * Lists every invite in the gym with an ACCURATE status: a lazy sweep first
 * flips any pending-but-past-expiry rows to `expired` (so the stored status
 * matches reality), and `effectiveInviteStatus` (inside `InviteList`) is used for
 * display as a belt-and-braces guard. The query carries no tenant predicate —
 * RLS (`invite_staff_all`) scopes it to the staff member's own gym.
 */
export default async function InvitesPage() {
  const session = await requireStaff();

  const invites = await withTenantContext(session.identity, async (c) => {
    // Bring stored statuses in line with real time before reading them.
    await expireStalePendingInvites(c);

    const { rows } = await c.query<InviteListRow>(
      `select i.id, i.email, i.status, i.expires_at, i.created_at, i.accepted_at,
              i.member_id,
              m.full_name    as member_name,
              m.auth_user_id as member_auth_user_id
         from invite i
         left join member m
           on m.id = i.member_id and m.tenant_id = i.tenant_id
        order by i.created_at desc`,
    );
    return rows;
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Invites</h1>
        <p className="text-sm text-slate-600">
          Portal invites across your gym. Resend a stale invite or revoke one
          that should no longer work.
        </p>
      </div>

      <InviteList
        invites={invites}
        renderActions={(row) => (
          <InviteRowActions
            inviteId={row.id}
            memberId={row.member_id}
            // Re-inviting an already-active member is pointless; otherwise a
            // pending/expired/revoked invite can be re-sent fresh.
            canResend={!row.member_auth_user_id && row.effective !== "accepted"}
            // Only a still-pending invite has a live token to revoke.
            canRevoke={row.effective === "pending"}
          />
        )}
      />
    </div>
  );
}
