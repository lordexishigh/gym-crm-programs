import { jwtVerify } from "jose";
import type { Identity } from "./db";

/**
 * Server-side identity derivation from a verified JWT.
 *
 * Identity is NEVER trusted from the browser/request body. The signed access
 * token is verified here and its claims are mapped to the DB session identity
 * consumed by `withTenantContext` (see `lib/db.ts`). The full request-flow
 * integration (cookie/session handling, Supabase Auth) lands in `mvp-auth`;
 * this module owns the token → identity mapping so RLS context can be set.
 */

export type AccessTokenClaims = {
  /** Auth user id (Supabase `sub`). */
  sub: string;
  /** Custom claim carrying the gym/tenant id. */
  tenant_id?: string;
  /** Custom claim: "staff" | "member". */
  app_role?: "staff" | "member";
  /** Custom claim carrying the Member row id for member sessions. */
  member_id?: string;
  /**
   * Supabase stores user-provisioned custom claims under `app_metadata` (set at
   * sign-up / invite acceptance and not editable by the end user). A custom
   * access-token hook may additionally promote them to top level — so we read
   * from either location (see `claimValue`).
   */
  app_metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Read a custom claim from the verified token, preferring a top-level claim
 * (set by an access-token hook) and falling back to `app_metadata`. Returns
 * undefined for missing/empty/non-string values.
 */
export function claimValue(
  claims: AccessTokenClaims,
  key: "tenant_id" | "app_role" | "member_id",
): string | undefined {
  const top = claims[key];
  if (typeof top === "string" && top.length > 0) return top;
  const meta = claims.app_metadata?.[key];
  return typeof meta === "string" && meta.length > 0 ? meta : undefined;
}

/** Which audience a verified token belongs to ("staff" by default). */
export function sessionRole(claims: AccessTokenClaims): "staff" | "member" {
  return claimValue(claims, "app_role") === "member" ? "member" : "staff";
}

/** Verify a Supabase-issued (HS256) access token and return its claims. */
export async function verifyAccessToken(
  token: string,
): Promise<AccessTokenClaims> {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error("SUPABASE_JWT_SECRET is not set.");
  }
  const { payload } = await jwtVerify(
    token,
    new TextEncoder().encode(secret),
  );
  return payload as AccessTokenClaims;
}

/** Map verified token claims to the DB session identity used by RLS. */
export function identityFromClaims(claims: AccessTokenClaims): Identity {
  const tenantId = claimValue(claims, "tenant_id");
  if (!tenantId) {
    throw new Error("Access token is missing the tenant_id claim.");
  }
  const role = sessionRole(claims);
  return {
    tenantId,
    role,
    userId: role === "staff" ? claims.sub : null,
    memberId: role === "member" ? (claimValue(claims, "member_id") ?? null) : null,
  };
}
