import { withAdminContext } from "@/lib/db";
import { hashInviteToken, isInviteExpired } from "@/lib/invites";
import { reportHandledError } from "@/lib/observability/monitoring";

/**
 * Invite-token lookup for the acceptance flow (mvp-member-management-004).
 *
 * This runs BEFORE any session exists, so it deliberately uses the privileged
 * `withAdminContext` (RLS-bypassing) path that lib/db.ts reserves for exactly
 * this case: resolving an invite by its token before a tenant context can be
 * established. Access is gated by possession of the high-entropy raw token,
 * which is never stored — only its hash is matched.
 */

export type InviteLookup =
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "used" }
  /**
   * The token could not be CHECKED — the database was unset or unreachable.
   *
   * Distinct from "invalid" on purpose. Collapsing the two would tell a member
   * holding a perfectly good invite that their link is broken, sending them to
   * their gym for a replacement that will fail in exactly the same way; and it
   * would hide a real outage behind a routine-looking message. This is the app's
   * fault, is transient, and the honest advice is "try again shortly".
   */
  | { status: "unavailable" }
  | {
      status: "valid";
      inviteId: string;
      tenantId: string;
      memberId: string;
      email: string;
      memberName: string;
    };

type Row = {
  invite_id: string;
  tenant_id: string;
  member_id: string | null;
  email: string;
  invite_status: string;
  expires_at: string | null;
  member_name: string | null;
  member_auth_user_id: string | null;
};

/**
 * Resolve a raw invite token to its current acceptance state. Returns a coarse
 * status (never leaks which gym/member) so the page and the action can branch
 * on the same source of truth.
 */
export async function lookupInviteByToken(
  rawToken: string | undefined,
): Promise<InviteLookup> {
  if (!rawToken) return { status: "invalid" };
  const tokenHash = hashInviteToken(rawToken);

  // The lookup is the FIRST thing an invite link does, and it runs while the
  // visitor is unauthenticated with nothing but the link to go on. An
  // unreachable database therefore used to throw straight out of the Server
  // Component into `app/invite/error.tsx` — so a dead, expired or simply
  // mistyped link rendered "Something went wrong" instead of the specific
  // guidance this function exists to produce. Contained here rather than at each
  // call site so the page and the action cannot disagree about it.
  let row: Row | null;
  try {
    row = await lookupRow(tokenHash);
  } catch (err) {
    await reportHandledError(err, "invite-lookup", { severity: "error" });
    return { status: "unavailable" };
  }

  if (!row || !row.member_id) return { status: "invalid" };
  if (row.invite_status === "accepted" || row.member_auth_user_id) {
    return { status: "used" };
  }
  // A row may already be flipped to 'expired' by the lazy sweep; report it as
  // expired (not a generic invalid) so the member sees the right guidance.
  if (row.invite_status === "expired") return { status: "expired" };
  // Revoked (and any other non-pending) tokens are rejected outright.
  if (row.invite_status !== "pending") return { status: "invalid" };
  if (isInviteExpired(row.expires_at)) return { status: "expired" };

  return {
    status: "valid",
    inviteId: row.invite_id,
    tenantId: row.tenant_id,
    memberId: row.member_id,
    email: row.email,
    memberName: row.member_name ?? "there",
  };
}

/** The token-hash lookup itself. Throws on a database failure; see the caller. */
function lookupRow(tokenHash: string): Promise<Row | null> {
  return withAdminContext(async (c) => {
    const { rows } = await c.query<Row>(
      `select i.id            as invite_id,
              i.tenant_id      as tenant_id,
              i.member_id      as member_id,
              i.email          as email,
              i.status         as invite_status,
              i.expires_at     as expires_at,
              m.full_name      as member_name,
              m.auth_user_id   as member_auth_user_id
         from invite i
         left join member m
           on m.id = i.member_id and m.tenant_id = i.tenant_id
        where i.token_hash = $1
        limit 1`,
      [tokenHash],
    );
    return rows[0] ?? null;
  });
}
