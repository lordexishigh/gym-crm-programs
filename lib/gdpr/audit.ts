import type { PoolClient } from "pg";

/**
 * GDPR audit-trail writes (beta-gdpr-001/002).
 *
 * Every data-subject action — export and erasure — is recorded in
 * `gdpr_audit_event` so the controller can demonstrate compliance. These run on
 * the caller's existing tenant-scoped client (inside `withTenantContext`), so
 * the audit row is written atomically with the action it records and is scoped
 * to the right tenant by RLS (see migration 0004).
 */

export type GdprAction = "export" | "erasure";

/**
 * Resolve the staff `users.id` for the current session. The JWT carries the
 * Supabase auth id (users.auth_user_id), but the audit FK targets users(id).
 * Returns null when unmatched (member self-service, or a since-removed user) —
 * the column is nullable and the audit row must never fail to write.
 */
export async function resolveActorUserId(
  c: PoolClient,
  authUserId: string | null | undefined,
): Promise<string | null> {
  if (!authUserId) return null;
  const { rows } = await c.query<{ id: string }>(
    "select id from users where auth_user_id = $1",
    [authUserId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Append one GDPR audit event using the caller's tenant-scoped client.
 *
 * The data subject is identified by exactly one of `subjectMemberId` (a member)
 * or `subjectUserId` (a staff user) — both are nullable so the audit row can
 * survive later erasure/cleanup of the row it references (the FKs are ON DELETE
 * SET NULL; see migrations 0004/0006).
 */
export async function recordGdprEvent(
  c: PoolClient,
  event: {
    tenantId: string;
    action: GdprAction;
    actorRole: "staff" | "member";
    actorUserId: string | null;
    subjectMemberId?: string | null;
    subjectUserId?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await c.query(
    `insert into gdpr_audit_event
       (tenant_id, action, actor_role, actor_user_id,
        subject_member_id, subject_user_id, detail)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      event.tenantId,
      event.action,
      event.actorRole,
      event.actorUserId,
      event.subjectMemberId ?? null,
      event.subjectUserId ?? null,
      event.detail ? JSON.stringify(event.detail) : null,
    ],
  );
}
