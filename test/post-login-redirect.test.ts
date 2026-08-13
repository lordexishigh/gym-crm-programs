import { describe, expect, it, beforeAll, beforeEach, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";

/**
 * Post-login destinations, and the dead ends around them.
 *
 * The review's finding was that NO post-login redirect destination had ever been
 * confirmed for either role: if sign-in succeeds but the destination declines the
 * session, a first-time user with demo credentials hits a wall immediately. This
 * suite pins both halves of that:
 *
 *   1. A good staff token lands on /dashboard; a good member token lands on
 *      /portal. Both destinations exist (app/dashboard/page.tsx,
 *      app/portal/page.tsx) and render unconditionally — neither depends on the
 *      gym having any data, so a freshly seeded demo gym is not a blank screen.
 *
 *   2. The LOOP: a token that verifies but resolves to no identity used to be
 *      accepted here and then rejected by the destination guard, bouncing the
 *      user back to an empty form with no error. Signing in again reproduced it
 *      forever. The actions must now refuse to establish such a session and
 *      report it on the form instead.
 *
 * Tokens are signed with a real ES256 key against a LOCAL JWKS, exactly as
 * test/identity.test.ts does — no Supabase project and no database required.
 */
const SUPABASE_URL = "https://test-project.supabase.co";
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const KID = "test-es256-key";

const keyset = vi.hoisted(() => ({ jwks: { keys: [] as JWK[] } }));
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return { ...actual, createRemoteJWKSet: () => actual.createLocalJWKSet(keyset.jwks) };
});

// The auth service: hand the action whichever token the test signed.
const auth = vi.hoisted(() => ({ token: "" }));
vi.mock("@/lib/auth/supabase", () => ({
  signInWithPassword: async () => ({
    ok: true,
    tokens: { accessToken: auth.token, refreshToken: "refresh-1", expiresIn: 3600 },
  }),
}));

/*
 * The brute-force throttle, stood down for this suite.
 *
 * Both actions call `guardLoginAttempt` before touching auth, and it reads
 * `headers()` from `next/headers` — unavailable outside a request, so every case
 * here would die on it. Faking `next/headers` instead would leave the real
 * sliding window running, and this file signs in ~8 times from one (absent, so
 * shared) IP bucket against a limit of 10: the suite would begin throttling
 * itself as cases were added, failing on an axis it does not test.
 *
 * Throttle policy has its own suite — test/login-throttle.test.ts — which is
 * where the buckets, the limits and the post-success reset are asserted. This
 * one is about WHERE a sign-in lands, so the guard is a pass-through and the
 * reset is merely recorded, to pin that only a genuinely usable sign-in reaches
 * it (see the `cleared` assertions below).
 */
const throttle = vi.hoisted(() => ({ cleared: [] as string[] }));
vi.mock("@/lib/auth/login-throttle", () => ({
  guardLoginAttempt: async () => null,
  clearLoginThrottle: async (scope: string) => {
    throttle.cleared.push(scope);
  },
}));

// Monitoring is a side channel: the actions report failures that are NOT a wrong
// password to it. Nothing here exercises those paths, and the real one would try
// to ship what it was given.
vi.mock("@/lib/observability/monitoring", () => ({
  reportHandledError: async () => {},
}));

// Cookie writes: record whether a session was committed. Mocked at the session
// module so `next/headers` (unavailable outside a request) is never reached.
const session = vi.hoisted(() => ({ established: 0 }));
vi.mock("@/lib/auth/session", () => ({
  establishSession: async () => {
    session.established += 1;
  },
}));

// `redirect` throws in Next (it unwinds the render); mirror that so a test can
// tell "redirected" from "returned a form error", and capture the destination.
const nav = vi.hoisted(() => ({ to: "" }));
class RedirectSignal extends Error {}
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    nav.to = path;
    throw new RedirectSignal(path);
  },
}));

import { loginAction } from "../app/login/actions";
import { memberLoginAction } from "../app/portal/login/actions";
import {
  ACCOUNT_NOT_LINKED_TO_GYM,
  MEMBER_LANDING,
  STAFF_LANDING,
} from "../lib/auth/sign-in-reason";

// See test/identity.test.ts: jose v6 keys are Web Crypto `CryptoKey`s.
let privateKey: CryptoKey;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  const { privateKey: priv, publicKey } = await generateKeyPair("ES256");
  privateKey = priv;
  keyset.jwks.keys = [
    { ...(await exportJWK(publicKey)), kid: KID, alg: "ES256", use: "sig" },
  ];
});

beforeEach(() => {
  session.established = 0;
  nav.to = "";
  throttle.cleared = [];
});

/** Sign an access token the way Supabase Auth would, with the given claims. */
async function signIn(claims: Record<string, unknown>): Promise<void> {
  auth.token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setSubject(String(claims.sub ?? "auth-user-1"))
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

function credentials(): FormData {
  const form = new FormData();
  form.set("email", "someone@demo.local");
  form.set("password", "correct-horse");
  return form;
}

/**
 * Run an action that is expected to redirect, and return where it went. Any
 * other outcome (a returned form error) fails here rather than downstream.
 */
async function destinationOf(
  action: (prev: { error?: string }, form: FormData) => Promise<{ error?: string }>,
): Promise<string> {
  try {
    const state = await action({}, credentials());
    throw new Error(
      `expected a redirect, but the action returned: ${JSON.stringify(state)}`,
    );
  } catch (err) {
    if (err instanceof RedirectSignal) return nav.to;
    throw err;
  }
}

describe("a successful sign-in lands on a real page", () => {
  it("sends staff to the dashboard", async () => {
    await signIn({ sub: "u-1", app_role: "staff", tenant_id: "gym-1" });
    expect(await destinationOf(loginAction)).toBe("/dashboard");
    expect(STAFF_LANDING).toBe("/dashboard");
    expect(session.established).toBe(1);
    // The success path still clears the brute-force counters, so a few typos
    // before the right password leave no penalty behind.
    expect(throttle.cleared).toEqual(["staff"]);
  });

  it("sends a member to the portal", async () => {
    await signIn({
      sub: "u-2",
      app_role: "member",
      tenant_id: "gym-1",
      member_id: "m-1",
    });
    expect(await destinationOf(memberLoginAction)).toBe("/portal");
    expect(MEMBER_LANDING).toBe("/portal");
    expect(session.established).toBe(1);
    expect(throttle.cleared).toEqual(["member"]);
  });

  it("accepts claims placed in app_metadata, as Supabase stores them", async () => {
    // The demo/seeded accounts carry their claims here rather than top-level, so
    // a check that only read top-level claims would reject every demo login.
    await signIn({
      sub: "u-3",
      app_metadata: { app_role: "member", tenant_id: "gym-1", member_id: "m-1" },
    });
    expect(await destinationOf(memberLoginAction)).toBe(MEMBER_LANDING);
  });
});

describe("a session the destination would reject is never established", () => {
  // Regression: this is the login → destination → login loop. The token verifies
  // and carries the right audience, so the old code established the session and
  // redirected; the destination guard then resolved no identity and bounced the
  // user back to an empty form. No error was ever shown, and retrying with the
  // same valid credentials looped indefinitely.
  it("staff: no tenant_id is a form error, not a redirect", async () => {
    await signIn({ sub: "u-4", app_role: "staff" });
    const state = await loginAction({}, credentials());
    expect(state.error).toBe(ACCOUNT_NOT_LINKED_TO_GYM);
    expect(session.established).toBe(0);
    expect(nav.to).toBe("");
    // A submission that cannot produce a working session is not a successful
    // sign-in, so it must not hand back a fresh password-guessing budget.
    expect(throttle.cleared).toEqual([]);
  });

  it("member: no tenant_id is a form error, not a redirect", async () => {
    await signIn({ sub: "u-5", app_role: "member", member_id: "m-1" });
    const state = await memberLoginAction({}, credentials());
    expect(state.error).toBe(ACCOUNT_NOT_LINKED_TO_GYM);
    expect(session.established).toBe(0);
    expect(nav.to).toBe("");
  });

  it("member: no member_id is a form error naming the invite link", async () => {
    // requireMember also bounces a memberless session, so this has to be caught
    // here too — and it is fixable by the member, so the message says how.
    await signIn({ sub: "u-6", app_role: "member", tenant_id: "gym-1" });
    const state = await memberLoginAction({}, credentials());
    expect(state.error).toMatch(/invite link/i);
    expect(session.established).toBe(0);
    expect(nav.to).toBe("");
  });

  it("keeps the two audiences on their own forms", async () => {
    // A member on the staff form (or the reverse) is rejected with a message
    // pointing at the other form — never redirected somewhere that would bounce.
    await signIn({ sub: "u-7", app_role: "member", tenant_id: "gym-1", member_id: "m-1" });
    expect((await loginAction({}, credentials())).error).toMatch(/member portal/i);

    await signIn({ sub: "u-8", app_role: "staff", tenant_id: "gym-1" });
    expect((await memberLoginAction({}, credentials())).error).toMatch(/staff/i);

    expect(session.established).toBe(0);
    expect(nav.to).toBe("");
  });
});
