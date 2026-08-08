import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decideMigrate,
  decideSignInCheck,
  gitBlockers,
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
 * `routeVerdict` above signs off on a deployment whose /login RENDERS. That is
 * not the same as one anyone can sign IN to — /login is statically prerendered,
 * so a rotated Supabase key or an unseeded database produces a flawless form that
 * refuses every credential, with the whole dashboard and portal stranded behind
 * it. That is the "built but not live" report this project keeps receiving, and
 * it is the one shape of it that a route check cannot see. This decides whether
 * the real sign-in journey (e2e/live/staff-login.spec.ts) runs to close the gap.
 */
describe("decideSignInCheck", () => {
  it("verifies sign-in when a browser driver is available", () => {
    const { check, reason } = decideSignInCheck({ env: {}, playwrightAvailable: true });
    expect(check).toBe(true);
    expect(reason).toMatch(/sign-in actually works/i);
  });

  it("skips — never fails — when Playwright is absent, and says the gap is open", () => {
    // deploy.mjs must stay runnable from a production install (`--omit=dev`),
    // where a browser driver is legitimately missing. Skipping silently would be
    // worse than not checking: it would read as a verified deploy.
    const { check, reason } = decideSignInCheck({ env: {}, playwrightAvailable: false });
    expect(check).toBe(false);
    expect(reason).toMatch(/not installed/);
    expect(reason).toMatch(/verify:live/);
  });

  it("honours DEPLOY_SKIP_SIGNIN_CHECK for a deploy that carries the fix", () => {
    const { check, reason } = decideSignInCheck({
      env: { DEPLOY_SKIP_SIGNIN_CHECK: "1" },
      playwrightAvailable: true,
    });
    expect(check).toBe(false);
    expect(reason).toMatch(/DEPLOY_SKIP_SIGNIN_CHECK/);
  });

  it("treats an empty/0/false override as unset", () => {
    for (const value of ["", "0", "false"]) {
      expect(
        decideSignInCheck({
          env: { DEPLOY_SKIP_SIGNIN_CHECK: value },
          playwrightAvailable: true,
        }).check,
      ).toBe(true);
    }
  });
});
