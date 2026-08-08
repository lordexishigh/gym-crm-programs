import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  REQUIRED_SECTIONS,
  portalVerdict,
  resolveBaseUrl,
  resolveMember,
} from "../scripts/smoke-portal.mjs";

/**
 * Guard for `npm run smoke:portal` (scripts/smoke-portal.mjs), the check that
 * proves the MEMBER PORTAL is actually being served by a deployment.
 *
 * The defect it answers has been reported round after round: "the member
 * self-service portal is built but the running app doesn't serve it". It kept
 * recurring because every automated check stopped at the front door — `/`,
 * `/login` and `/portal/login` are static, prerendered, database-free pages that
 * render perfectly on a deployment whose portal is broken.
 *
 * These tests exercise the pure DECISIONS only: no browser, no network, no
 * deployment. What counts as "the portal is serving", which URL is checked, and
 * which credentials are used.
 */

const SMOKE_SRC = readFileSync(
  path.join(process.cwd(), "scripts", "smoke-portal.mjs"),
  "utf8",
);

/**
 * A shebang in a script a test imports silently destroys the whole suite: Vitest
 * hoists Vite's CJS-interop declarations above it, and a shebang is only valid as
 * the very first bytes of a file, so the module throws at import and 0 tests
 * load. test/deploy-script.test.ts documents the same trap for the scripts it
 * imports; this file imports one more, so it carries the same guard.
 */
it("scripts/smoke-portal.mjs starts with no shebang", () => {
  expect(SMOKE_SRC.startsWith("#!")).toBe(false);
});

describe("portalVerdict", () => {
  const allHeadings = [
    "Foundation Strength — Week 1",
    "Log a workout",
    "Classes",
    "Membership",
    "Payment history",
  ];

  it("passes when every required section rendered", () => {
    expect(portalVerdict(allHeadings)).toEqual({ ok: true, missing: [] });
  });

  it("tolerates surrounding whitespace on a heading", () => {
    expect(portalVerdict(["  Classes  ", "Membership", "\nPayment history\n"]).ok).toBe(
      true,
    );
  });

  it("fails when the portal renders nothing", () => {
    const verdict = portalVerdict([]);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toHaveLength(3);
  });

  it("names the missing FEATURE, not just the heading", () => {
    // The operator reading this is triaging a product gap, so the message has to
    // say which promised capability is absent.
    const verdict = portalVerdict(["Classes", "Membership"]);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toHaveLength(1);
    expect(verdict.missing[0]).toMatch(/payment history/i);
    expect(verdict.missing[0]).toMatch(/Payment history/);
  });

  it("reports every missing section, not just the first", () => {
    expect(portalVerdict(["Membership"]).missing).toHaveLength(2);
  });

  it("requires an EXACT heading — a substring must not satisfy it", () => {
    // "Classes" must not be signed off by an unrelated "Classes you missed"
    // heading, which would let a half-rendered portal pass.
    expect(portalVerdict(["Classes you missed", "Membership", "Payment history"]).ok).toBe(
      false,
    );
  });

  it("covers exactly the three features the portal promises", () => {
    expect(REQUIRED_SECTIONS.map((s) => s.heading)).toEqual([
      "Classes",
      "Membership",
      "Payment history",
    ]);
  });
});

describe("resolveBaseUrl", () => {
  it("defaults to production", () => {
    expect(resolveBaseUrl({}, [])).toBe("https://gym-crm-programs.vercel.app");
  });

  it("shares DEPLOY_VERIFY_URL with scripts/deploy.mjs", () => {
    // One variable must steer the deploy and its portal check together — two
    // knobs would let them assert against different environments.
    expect(resolveBaseUrl({ DEPLOY_VERIFY_URL: "https://staging.example" }, [])).toBe(
      "https://staging.example",
    );
  });

  it("prefers --base over the environment", () => {
    expect(
      resolveBaseUrl({ DEPLOY_VERIFY_URL: "https://staging.example" }, [
        "node",
        "smoke-portal.mjs",
        "--base",
        "http://localhost:3000",
      ]),
    ).toBe("http://localhost:3000");
  });

  it("strips a trailing slash so paths are not doubled", () => {
    expect(resolveBaseUrl({ SMOKE_BASE_URL: "https://example.test/" }, [])).toBe(
      "https://example.test",
    );
  });
});

describe("resolveMember", () => {
  /**
   * Pull the fallback out of a `const X = process.env.Y || "default";` line in the
   * seed — mirroring test/demo-accounts.test.ts, which keeps the landing page's
   * advertised credentials honest the same way.
   */
  const SEED_SRC = readFileSync(
    path.join(process.cwd(), "scripts", "seed.mjs"),
    "utf8",
  );
  function seedDefault(constName: string): string | null {
    const match = new RegExp(
      `const\\s+${constName}\\s*=\\s*process\\.env\\.\\w+\\s*\\|\\|\\s*"([^"]*)"`,
    ).exec(SEED_SRC);
    return match ? match[1] : null;
  }

  it("defaults to the credentials scripts/seed.mjs actually provisions", () => {
    // Drift here is the quiet failure: a smoke check that signs in with a
    // password the seed no longer sets reports "portal not serving" on a
    // perfectly healthy deployment — reviving the exact false finding this
    // script exists to disprove.
    const email = seedDefault("MEMBER_EMAIL");
    const password = seedDefault("MEMBER_PASSWORD");
    expect(email, "could not read MEMBER_EMAIL from scripts/seed.mjs").toBeTruthy();
    expect(password, "could not read MEMBER_PASSWORD from scripts/seed.mjs").toBeTruthy();

    expect(resolveMember({})).toEqual({ email, password });
  });

  it("honours the seed's own override variables", () => {
    // Reusing SEED_MEMBER_* rather than inventing SMOKE_* names means a
    // deployment seeded with custom credentials is verifiable with no extra
    // configuration, and there is no third copy of these values to drift.
    expect(
      resolveMember({
        SEED_MEMBER_EMAIL: "real@gym.cy",
        SEED_MEMBER_PASSWORD: "s3cret",
      }),
    ).toEqual({ email: "real@gym.cy", password: "s3cret" });
  });
});
