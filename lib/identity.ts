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
  [key: string]: unknown;
};

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
  if (!claims.tenant_id) {
    throw new Error("Access token is missing the tenant_id claim.");
  }
  const role = claims.app_role === "member" ? "member" : "staff";
  return {
    tenantId: claims.tenant_id,
    role,
    userId: role === "staff" ? claims.sub : null,
    memberId: role === "member" ? (claims.member_id ?? null) : null,
  };
}
