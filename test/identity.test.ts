import { describe, expect, it, beforeAll } from "vitest";
import { SignJWT } from "jose";
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
 * rejected. No database or network is required.
 */
const SECRET = "test-jwt-secret-please-ignore-0000000000";

beforeAll(() => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
});

function sign(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(claims.sub ?? "auth-user-1"))
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
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

  it("rejects a token signed with the wrong secret (tampered)", async () => {
    const bad = await new SignJWT({ sub: "x", tenant_id: "gym-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("a-different-secret-0000000000000000"));
    await expect(verifyAccessToken(bad)).rejects.toThrow();
  });
});
