import type { PoolClient } from "pg";
import { withTenantContext, type Identity } from "@/lib/db";
import { isStaffRole, type StaffRole } from "@/lib/permissions";

// Re-exported so existing importers keep working; the matrix and the type both
// live in lib/permissions.ts, which is DB-free and safe in a client bundle.
export type { StaffRole };

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
 * Resolve the signed-in staff member's `users.role`
 * ("owner" | "trainer" | "front_desk").
 *
 * The JWT only carries `app_role` ("staff" | "member") — the job-role
 * distinction lives in the `users` row, so this is a small extra read
 * (RLS-scoped, same pattern as `resolveStaffUserId`).
 *
 * Falls back to "trainer" when the row cannot be resolved. That is NOT the
 * least-privileged role any more (front_desk is), and the choice is deliberate:
 * an unresolvable row means the staff account is not provisioned at all, and
 * silently reclassifying every such session as front desk would strip program
 * access from working trainer accounts on a transient read failure. It still
 * cannot grant anything owner-only — billing and staff administration stay shut.
 */
export async function getStaffRole(identity: Identity): Promise<StaffRole> {
  if (!identity.userId) return "trainer";
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<{ role: string }>(
      "select role from users where auth_user_id = $1",
      [identity.userId],
    );
    const role = rows[0]?.role;
    // An unknown value in the column (a role added by a newer migration than
    // this build knows about) must not widen access — treat it as a trainer.
    return isStaffRole(role) ? role : "trainer";
  });
}

/**
 * The same identity with its staff role attached, so `withTenantContext` can
 * stamp `app.staff_role` and the role-scoped RLS policies (0026) apply.
 *
 * Used by the request paths that do NOT go through `requireStaff` — currently
 * the kiosk JSON endpoint, which returns 401 rather than redirecting and so
 * cannot use a redirecting guard.
 */
export async function withStaffRole(identity: Identity): Promise<Identity> {
  if (identity.staffRole) return identity;
  return { ...identity, staffRole: await getStaffRole(identity) };
}
