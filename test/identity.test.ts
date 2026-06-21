import { describe, expect, it, beforeAll, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from "jose";
import {
  claimValue,
  identityFromClaims,
  sessionRole,
  verifyAccessToken,
  type AccessTokenClaims,
} from "../lib/identity";

/**
 * Unit tests for the JWT → DB-identity mapping (mvp-auth-001).
 *
 * These assert the central auth guarantee: tenant_id / role / member_id are
 * derived from VERIFIED token claims only, support both top-level and
 * app_metadata claim placement, and that an unverifiable/tampered token is
 * rejected.
 *
 * Tokens are signed with an asymmetric ES256 key and verified against a JWKS —
 * exactly like production. `createRemoteJWKSet` is mocked to a LOCAL key set
 * (our test public key) so no real network or Supabase project is required.
 */
const SUPABASE_URL = "https://test-project.supabase.co";
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const KID = "test-es256-key";

// Shared holder the hoisted mock factory reads from; populated in beforeAll.
const keyset = vi.hoisted(() => ({ jwks: { keys: [] as unknown[] } }));
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return { ...actual, createRemoteJWKSet: () => actual.createLocalJWKSet(keyset.jwks) };
});

let privateKey: KeyLike;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  const { privateKey: priv, publicKey } = await generateKeyPair("ES256");
  privateKey = priv;
  keyset.jwks.keys = [{ ...(await exportJWK(publicKey)), kid: KID, alg: "ES256", use: "sig" }];
});

function sign(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setSubject(String(claims.sub ?? "auth-user-1"))
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

describe("claimValue", () => {
  it("reads a top-level claim", () => {
    const claims = { sub: "x", tenant_id: "t-top" } as AccessTokenClaims;
    expect(claimValue(claims, "tenant_id")).toBe("t-top");
  });

  it("falls back to app_metadata", () => {
    const claims = {
      sub: "x",
      app_metadata: { tenant_id: "t-meta", app_role: "member", member_id: "m-1" },
    } as AccessTokenClaims;
    expect(claimValue(claims, "tenant_id")).toBe("t-meta");
    expect(claimValue(claims, "member_id")).toBe("m-1");
  });

  it("ignores empty strings", () => {
    const claims = {
      sub: "x",
      tenant_id: "",
      app_metadata: { tenant_id: "t-meta" },
    } as AccessTokenClaims;
    expect(claimValue(claims, "tenant_id")).toBe("t-meta");
  });
});

describe("sessionRole", () => {
  it("defaults to staff", () => {
    expect(sessionRole({ sub: "x" } as AccessTokenClaims)).toBe("staff");
  });

  it("is member when app_role=member (top-level or app_metadata)", () => {
    expect(
      sessionRole({ sub: "x", app_role: "member" } as AccessTokenClaims),
    ).toBe("member");
    expect(
      sessionRole({
        sub: "x",
        app_metadata: { app_role: "member" },
      } as AccessTokenClaims),
    ).toBe("member");
  });
});

describe("identityFromClaims", () => {
  it("maps a staff session (userId set, no memberId)", () => {
    const id = identityFromClaims({
      sub: "user-1",
      tenant_id: "gym-1",
      app_role: "staff",
    } as AccessTokenClaims);
    expect(id).toEqual({
      tenantId: "gym-1",
      role: "staff",
      userId: "user-1",
      memberId: null,
    });
  });

  it("maps a member session from app_metadata (memberId set, no userId)", () => {
    const id = identityFromClaims({
      sub: "auth-2",
      app_metadata: { tenant_id: "gym-9", app_role: "member", member_id: "mem-7" },
    } as AccessTokenClaims);
    expect(id).toEqual({
      tenantId: "gym-9",
      role: "member",
      userId: null,
      memberId: "mem-7",
    });
  });

  it("throws when tenant_id is absent (never inferred from elsewhere)", () => {
    expect(() =>
      identityFromClaims({ sub: "x", app_role: "staff" } as AccessTokenClaims),
    ).toThrow(/tenant_id/);
  });
});

describe("verifyAccessToken", () => {
  it("verifies a correctly-signed token and yields identity", async () => {
    const token = await sign({
      sub: "user-1",
      tenant_id: "gym-1",
      app_role: "staff",
    });
    const claims = await verifyAccessToken(token);
    expect(identityFromClaims(claims).tenantId).toBe("gym-1");
  });

  it("rejects a token signed by a key not in the JWKS (tampered)", async () => {
    const { privateKey: rogue } = await generateKeyPair("ES256");
    const bad = await new SignJWT({ sub: "x", tenant_id: "gym-1" })
      .setProtectedHeader({ alg: "ES256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience("authenticated")
      .setExpirationTime("1h")
      .sign(rogue);
    await expect(verifyAccessToken(bad)).rejects.toThrow();
  });
});
