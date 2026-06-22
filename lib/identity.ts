import { createRemoteJWKSet, jwtVerify } from "jose";
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

/**
 * Lazily-built remote JWKS for the project's Supabase Auth instance. `jose`
 * caches the fetched public keys and transparently handles key rotation, so we
 * construct it once per runtime (rebuilding only if the project URL changes).
 */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksUrl: string | null = null;

function projectBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set.");
  return url.replace(/\/$/, "");
}

function getJwks(base: string): ReturnType<typeof createRemoteJWKSet> {
  const target = `${base}/auth/v1/.well-known/jwks.json`;
  if (!jwks || jwksUrl !== target) {
    jwks = createRemoteJWKSet(new URL(target));
    jwksUrl = target;
  }
  return jwks;
}

/**
 * Verify a Supabase-issued access token against the project's published JWKS
 * (asymmetric ES256 signing keys) and return its claims. No shared secret is
 * stored anywhere; the issuer and audience are validated as defence-in-depth.
 * Edge-safe — uses only `jose` + `fetch`.
 *
 * `algorithms` is pinned to ES256 (the project's asymmetric signing algorithm)
 * so a token presenting any other `alg` header is rejected outright. This closes
 * algorithm-substitution attacks — e.g. a forged `alg: HS256` / `alg: none`
 * token, or one signed with a key type the JWKS does not publish — rather than
 * relying on key-by-`kid` resolution alone. `jwtVerify` also enforces `exp`
 * (and `nbf`/`iat` when present) by default, so an expired token never verifies.
 */
export async function verifyAccessToken(
  token: string,
): Promise<AccessTokenClaims> {
  const base = projectBaseUrl();
  const { payload } = await jwtVerify(token, getJwks(base), {
    issuer: `${base}/auth/v1`,
    audience: "authenticated",
    algorithms: ["ES256"],
  });
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
