import type { PoolClient } from "pg";
import { withTenantContext, type Identity } from "@/lib/db";

export type StaffRole = "owner" | "trainer";

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

/**
 * Resolve the signed-in staff member's `users.role` ("owner" | "trainer").
 *
 * The JWT only carries `app_role` ("staff" | "member") — the owner/trainer
 * distinction lives in the `users` row, so this is a small extra read
 * (RLS-scoped, same pattern as `resolveStaffUserId`). Defaults to "trainer"
 * (the least-privileged role) when the row can't be resolved, so a lookup
 * failure never accidentally grants owner-only access.
 */
export async function getStaffRole(identity: Identity): Promise<StaffRole> {
  if (!identity.userId) return "trainer";
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<{ role: StaffRole }>(
      "select role from users where auth_user_id = $1",
      [identity.userId],
    );
    return rows[0]?.role ?? "trainer";
  });
}
