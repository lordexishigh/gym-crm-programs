import type { PoolClient } from "pg";

/**
 * Resolve the signed-in staff member's `users.id` (the FK target for
 * `created_by` / `assigned_by` columns) from their auth user id, best-effort.
 *
 * Runs inside an existing `withTenantContext` transaction, so the lookup is RLS
 * scoped to the current gym. Returns null when the id is absent or unresolved
 * (the FK columns are nullable on purpose — provenance is nice-to-have, not a
 * hard requirement).
 */
export async function resolveStaffUserId(
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
