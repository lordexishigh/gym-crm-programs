import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decideMigrate,
  gitBlockers,
  memberAuthPlan,
  memberSignInVerdict,
  routeVerdict,
} from "../scripts/deploy.mjs";

/**
 * Policy guard for `npm run deploy` (scripts/deploy.mjs).
 *
 * The defect this script answers is "built but not live": the code is correct and
 * pushed, and the running app serves an older build. It recurred because this
 * repository had no reachable deploy path — GitHub Actions is billing-blocked
 * ("The job was not started because recent account payments have failed"), and the
 * Vercel project has no Git link, so a push reached production by no route at all.
 *
 * These tests exercise the pure DECISIONS, never a real deploy: no network, no
 * `vercel` CLI, no database. The three functions below are the whole policy —
 * what blocks a deploy, whether migrations run first, and what counts as "live".
 */

/**
 * A shebang in a script that a test IMPORTS silently destroys that whole suite.
 *
 * Vitest transforms these modules through Vite, which rewrites `import` of node
 * builtins into CJS-interop `const` declarations and hoists them to the top of
 * the file — ahead of the shebang. A shebang is only valid as the very first
 * bytes of a source file; anywhere else it is a bare `#`, so the module throws
 * "SyntaxError: Invalid or unexpected token" at import and the suite loads 0
 * tests. That is exactly what had happened to test/postinstall.test.ts: `npm test`
 * was red and the regression guard for the install-time build — the machinery
 * that keeps `/login` a prerendered 4ms response instead of a 20s dev compile —
 * was not running at all, while every assertion inside it was still correct.
 *
 * Nothing executes these files directly (npm runs `node scripts/<name>.mjs`), so
 * the shebang is decorative and must stay absent.
 */
describe("scripts imported by tests must not carry a shebang", () => {
  for (const script of ["postinstall.mjs", "deploy.mjs"]) {
    it(`scripts/${script} starts with no shebang`, () => {
      const source = readFileSync(
        path.join(process.cwd(), "scripts", script),
        "utf8",
      );
      expect(source.startsWith("#!")).toBe(false);
    });
  }
});

describe("gitBlockers", () => {
  it("allows a clean, pushed checkout", () => {
    expect(gitBlockers({ dirty: false, unpushed: 0, env: {} })).toEqual([]);
  });

  it("blocks unpushed commits — the live app must never be ahead of master", () => {
    const blockers = gitBlockers({ dirty: false, unpushed: 2, branch: "master", env: {} });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/ahead of its remote/);
    expect(blockers[0]).toMatch(/Push first/);
  });

  it("blocks a dirty working tree", () => {
    const blockers = gitBlockers({ dirty: true, unpushed: 0, env: {} });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/uncommitted changes/);
  });

  it("reports both problems at once rather than one per run", () => {
    expect(gitBlockers({ dirty: true, unpushed: 3, env: {} })).toHaveLength(2);
  });

  it("DEPLOY_ALLOW_DIRTY=1 overrides for a deliberate hotfix", () => {
    expect(
      gitBlockers({ dirty: true, unpushed: 5, env: { DEPLOY_ALLOW_DIRTY: "1" } }),
    ).toEqual([]);
  });

  it("treats an empty/0/false override as unset", () => {
    for (const value of ["", "0", "false"]) {
      expect(gitBlockers({ dirty: true, env: { DEPLOY_ALLOW_DIRTY: value } })).toHaveLength(1);
    }
  });
});

describe("decideMigrate", () => {
  it("migrates before deploying when a connection string is available", () => {
    const { migrate, reason } = decideMigrate({
      env: { DATABASE_URL: "postgres://localhost/alpha" },
    });
    expect(migrate).toBe(true);
    expect(reason).toMatch(/before the new build goes live/);
  });

  it("prefers MIGRATE_DATABASE_URL, which is the DDL-capable direct connection", () => {
    expect(
      decideMigrate({ env: { MIGRATE_DATABASE_URL: "postgres://direct/alpha" } }).migrate,
    ).toBe(true);
  });

  it("does not block the deploy when no connection string is present", () => {
    // The ordering guarantee is still met by the boot-time runner in
    // instrumentation.ts; requiring production DB credentials on a laptop would
    // make the only working deploy path unusable.
    const { migrate, reason } = decideMigrate({ env: {} });
    expect(migrate).toBe(false);
    expect(reason).toMatch(/instrumentation\.ts/);
    expect(reason).toMatch(/on boot before serving/);
  });

  it("honours DEPLOY_SKIP_MIGRATE", () => {
    const { migrate } = decideMigrate({
      env: { DATABASE_URL: "postgres://localhost/alpha", DEPLOY_SKIP_MIGRATE: "1" },
    });
    expect(migrate).toBe(false);
  });
});

describe("routeVerdict", () => {
  const ok = (path: string) => ({ path, status: 200, hasMarker: true, marker: "m" });

  it("passes when every entry route renders", () => {
    const verdict = routeVerdict([ok("/"), ok("/login"), ok("/portal/login")]);
    expect(verdict).toEqual({ ok: true, failures: [] });
  });

  it("fails a route that did not respond at all", () => {
    const verdict = routeVerdict([
      { path: "/login", status: null, hasMarker: false, marker: "Staff sign in" },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toMatch(/did not respond/);
  });

  it("fails a non-200", () => {
    const verdict = routeVerdict([
      { path: "/portal/login", status: 500, hasMarker: false, marker: "Member sign in" },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toMatch(/returned HTTP 500/);
  });

  it("fails a 200 whose page did not render — a status alone is not evidence", () => {
    // Next.js serves error boundaries and not-found shells with friendly
    // statuses, so "200" would otherwise sign off on an unreachable product.
    const verdict = routeVerdict([
      { path: "/login", status: 200, hasMarker: false, marker: "Staff sign in" },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toMatch(/did not render/);
    expect(verdict.failures[0]).toMatch(/Staff sign in/);
  });

  it("reports every broken route, not just the first", () => {
    const verdict = routeVerdict([
      ok("/"),
      { path: "/login", status: 503, hasMarker: false, marker: "Staff sign in" },
      { path: "/portal/login", status: null, hasMarker: false, marker: "Member sign in" },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(2);
  });
});

/**
 * The check that answers the recurring "member authentication is built but the
 * running app doesn't serve it" report.
 *
 * `routeVerdict` above can only see that /portal/login RENDERS, and it is a
 * static page — it renders identically on a deployment where no member can get
 * in. These two functions are what turns that from an unfalsifiable claim into
 * an observed fact at deploy time.
 */
describe("memberAuthPlan", () => {
  const ISSUER = "https://proj.supabase.co/auth/v1";
  const configured = {
    NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  };

  it("verifies against the issuer the DEPLOYMENT reports, not the local one", () => {
    const plan = memberAuthPlan({ env: configured, issuer: ISSUER });
    expect(plan.check).toBe(true);
    expect(plan.issuer).toBe(ISSUER);
    expect(plan.key).toBe("sb_publishable_test");
  });

  it("defaults to the seeded demo member", () => {
    const plan = memberAuthPlan({ env: configured, issuer: ISSUER });
    expect(plan.email).toBe("member@demo.local");
    expect(plan.password).toBe("DemoMember!2026");
  });

  it("honours SEED_MEMBER_* and DEPLOY_VERIFY_MEMBER_* overrides", () => {
    expect(
      memberAuthPlan({
        env: { ...configured, SEED_MEMBER_EMAIL: "seeded@gym.cy" },
        issuer: ISSUER,
      }).email,
    ).toBe("seeded@gym.cy");

    // The deploy-specific override wins — it names a real account on an
    // environment that was never seeded with demo data.
    const plan = memberAuthPlan({
      env: {
        ...configured,
        SEED_MEMBER_EMAIL: "seeded@gym.cy",
        DEPLOY_VERIFY_MEMBER_EMAIL: "real@gym.cy",
        DEPLOY_VERIFY_MEMBER_PASSWORD: "hunter2",
      },
      issuer: ISSUER,
    });
    expect(plan.email).toBe("real@gym.cy");
    expect(plan.password).toBe("hunter2");
  });

  it("refuses to conclude anything when the local project is a DIFFERENT one", () => {
    // The dangerous false pass: some other Supabase project accepts the
    // credential and the deploy is declared verified while the live app has
    // never heard of that project.
    const plan = memberAuthPlan({
      env: { ...configured, NEXT_PUBLIC_SUPABASE_URL: "https://other.supabase.co" },
      issuer: ISSUER,
    });
    expect(plan.check).toBe(false);
    expect(plan.reason).toMatch(/not the one the deployment uses/);
    expect(plan.reason).toMatch(/other\.supabase\.co/);
    expect(plan.reason).toMatch(/proj\.supabase\.co/);
  });

  it("tolerates a trailing slash on the local URL rather than reading it as a mismatch", () => {
    expect(
      memberAuthPlan({
        env: { ...configured, NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.co/" },
        issuer: ISSUER,
      }).check,
    ).toBe(true);
  });

  it("skips when this environment has no auth config to sign in with", () => {
    const plan = memberAuthPlan({ env: {}, issuer: ISSUER });
    expect(plan.check).toBe(false);
    expect(plan.reason).toMatch(/member sign-in was NOT/i);
  });

  it("skips when the deployment reports no issuer — already warned about", () => {
    const plan = memberAuthPlan({ env: configured, issuer: null });
    expect(plan.check).toBe(false);
    expect(plan.reason).toMatch(/unconfigured/);
  });

  it("honours DEPLOY_SKIP_AUTH_CHECK", () => {
    expect(
      memberAuthPlan({
        env: { ...configured, DEPLOY_SKIP_AUTH_CHECK: "1" },
        issuer: ISSUER,
      }).check,
    ).toBe(false);
  });
});

describe("memberSignInVerdict", () => {
  /** A GoTrue token payload, in the `app_metadata` shape Supabase actually issues. */
  const token = (appMetadata: Record<string, string>) =>
    `${Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url")}.${Buffer.from(
      JSON.stringify({ sub: "u1", app_metadata: appMetadata }),
    ).toString("base64url")}.sig`;

  const memberToken = token({
    app_role: "member",
    tenant_id: "t1",
    member_id: "m1",
  });

  it("passes a member token that resolves to a portal session", () => {
    const verdict = memberSignInVerdict({ status: 200, accessToken: memberToken });
    expect(verdict.ok).toBe(true);
    expect(verdict.severity).toBe("ok");
  });

  it("reads claims promoted to the top level too, as lib/identity.ts does", () => {
    const promoted = `h.${Buffer.from(
      JSON.stringify({ sub: "u1", app_role: "member", tenant_id: "t1", member_id: "m1" }),
    ).toString("base64url")}.sig`;
    expect(memberSignInVerdict({ status: 200, accessToken: promoted }).ok).toBe(true);
  });

  /**
   * The whole point of the check: these all AUTHENTICATE. A deployment in this
   * state serves /portal/login, accepts the password, and then bounces the
   * member straight back to the form — a login loop that is indistinguishable
   * from "the feature was never deployed" to anyone looking from outside.
   */
  it("fails a token with no tenant_id — no RLS session can be established", () => {
    const verdict = memberSignInVerdict({
      status: 200,
      accessToken: token({ app_role: "member", member_id: "m1" }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.severity).toBe("fatal");
    expect(verdict.detail).toMatch(/tenant_id/);
  });

  it("fails a token with no member_id — requireMember rejects it", () => {
    const verdict = memberSignInVerdict({
      status: 200,
      accessToken: token({ app_role: "member", tenant_id: "t1" }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.severity).toBe("fatal");
    expect(verdict.detail).toMatch(/member_id/);
  });

  it("fails a staff account — /portal is not reachable with it", () => {
    const verdict = memberSignInVerdict({
      status: 200,
      accessToken: token({ app_role: "staff", tenant_id: "t1" }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.severity).toBe("fatal");
    expect(verdict.detail).toMatch(/not a member account/);
  });

  it("fails hard when the auth service is broken — nobody can sign in", () => {
    expect(memberSignInVerdict({ status: null }).severity).toBe("fatal");
    expect(memberSignInVerdict({ status: 503, error: "boom" }).severity).toBe("fatal");
    // A 200 with no token is a broken service, not a wrong password.
    expect(memberSignInVerdict({ status: 200, accessToken: null }).severity).toBe("fatal");
  });

  it("fails hard on a token it cannot decode", () => {
    expect(
      memberSignInVerdict({ status: 200, accessToken: "not-a-jwt" }).severity,
    ).toBe("fatal");
  });

  /**
   * Deliberately NOT fatal. A real gym runs with SEED_DEMO_DATA=0 and has no
   * demo member at all, so failing the deploy here would block every legitimate
   * production deploy on a missing fake account.
   */
  it("only warns when the credentials are rejected", () => {
    const verdict = memberSignInVerdict({ status: 400 });
    expect(verdict.ok).toBe(false);
    expect(verdict.severity).toBe("warn");
    expect(verdict.detail).toMatch(/npm run seed/);
    expect(verdict.detail).toMatch(/DEPLOY_SKIP_AUTH_CHECK/);
  });
});
