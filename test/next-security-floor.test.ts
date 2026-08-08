import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Next.js security floor.
 *
 * On 2026-07-21 Next.js shipped a coordinated nine-advisory security release
 * across both supported lines — 15.5.21 (Maintenance LTS) and 16.2.11 (Active
 * LTS), published within a minute of each other. Two of those advisories are
 * directly relevant to Alpha CRM:
 *
 *   - GHSA-m99w-x7hq-7vfj / CVE-2026-64641 (High) — "Denial of Service in App
 *     Router using Server Actions". Unauthenticated CPU-exhaustion reachable
 *     through *any* Server Action. This app is built on Server Actions (login,
 *     member CRUD, CSV import, class booking, check-in), so there is no subset
 *     of the product that sits outside the blast radius.
 *   - GHSA-6gpp-xcg3-4w24 / CVE-2026-64642 (High) — "Middleware / Proxy bypass
 *     in App Router applications using Turbopack and single locale". A bypass
 *     of `middleware.ts` would defeat the session gate on /dashboard and
 *     /portal, which is the outer layer of this app's tenant isolation.
 *
 * The project is on the patched 15.5.21 and `npm audit` is clean. This suite
 * exists so it *stays* there. The realistic regression is not someone typing a
 * downgrade on purpose — it is a revert. Reverting a range of commits that
 * happens to touch package.json/package-lock.json would move Next back below
 * the floor silently, and nothing else in CI inspects the dependency version.
 * (That pattern has bitten this repo before: a blanket revert taken for an
 * unrelated regression swept up several already-good fixes with it.)
 *
 * Deliberately expressed as a floor per major line, not an exact pin: upgrading
 * to a newer patch, or moving onto the 16.x Active LTS line, should pass. Only
 * dropping beneath that line's patched release fails.
 */

/** Patched release per supported LTS line (2026-07-21 security release). */
const PATCHED_FLOOR: Record<number, string> = {
  15: "15.5.21", // Maintenance LTS
  16: "16.2.11", // Active LTS
};

const ROOT = process.cwd();

function readJson(...segments: string[]): any {
  return JSON.parse(readFileSync(path.join(ROOT, ...segments), "utf8"));
}

/** `[major, minor, patch]`, ignoring any prerelease/build suffix. */
function parseVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`unparseable version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative if `a` precedes `b`, positive if it follows, 0 if equal. */
function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/**
 * The lowest version a dependency range can install. `^15.5.21` and `~15.5.21`
 * and `>=15.5.21` all admit 15.5.21 as their minimum; a bare `15.5.21` pins it.
 * Ranges with no concrete lower bound (`*`, `latest`, a git or file specifier)
 * return null — those cannot be checked, and are rejected separately below,
 * because "whatever npm feels like resolving" is not a security floor.
 */
function rangeMinimum(range: string): string | null {
  const match = /^\s*(?:\^|~|>=|=|v)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/.exec(
    range,
  );
  return match ? match[1] : null;
}

/** Assert `version` is at or above the patched floor for its own major line. */
function expectAtOrAboveFloor(version: string, source: string): void {
  const [major] = parseVersion(version);
  const floor = PATCHED_FLOOR[major];
  expect(
    floor,
    `${source} is Next ${version}, on major line ${major}, which has no ` +
      `recorded patched release. Supported lines are ${Object.keys(PATCHED_FLOOR)
        .map((line) => `${line}.x`)
        .join(" and ")}. If Next has cut a new LTS line, add its patched ` +
      `version to PATCHED_FLOOR rather than widening this check.`,
  ).toBeDefined();

  expect(
    compareVersions(version, floor!) >= 0,
    `${source} is Next ${version}, below the patched ${floor} on the ` +
      `${major}.x line. That release fixed CVE-2026-64641 (Server Action DoS) ` +
      `and CVE-2026-64642 (middleware auth bypass) among seven others. ` +
      `Run \`npm install next@${floor}\` (or a later patch) and commit both ` +
      `package.json and package-lock.json.`,
  ).toBe(true);
}

describe("Next.js security floor", () => {
  it("declares a dependency range that cannot resolve below the patched release", () => {
    const declared = readJson("package.json").dependencies?.next;
    expect(declared, "package.json does not depend on `next`").toBeTruthy();

    const minimum = rangeMinimum(declared);
    expect(
      minimum,
      `the \`next\` range "${declared}" has no concrete lower bound, so it ` +
        `cannot guarantee a patched version. Pin a range such as "^${PATCHED_FLOOR[15]}".`,
    ).not.toBeNull();

    expectAtOrAboveFloor(minimum!, `the \`next\` range in package.json ("${declared}")`);
  });

  it("locks a resolved version at or above the patched release", () => {
    // The lockfile is what `npm ci` installs, in CI and in the deploy build —
    // so it is the version that actually ships, regardless of the range above.
    const entry = readJson("package-lock.json").packages?.["node_modules/next"];
    expect(entry?.version, "package-lock.json has no `node_modules/next` entry").toBeTruthy();
    expectAtOrAboveFloor(entry.version, "package-lock.json's resolved `next`");
  });

  it("has the patched release actually installed", () => {
    // Guards the case where the manifest and lockfile are correct but the local
    // tree is stale — this repo has a known failure mode where dependency
    // changes do not take effect without a clean reinstall.
    let installed: string;
    try {
      installed = readJson("node_modules", "next", "package.json").version;
    } catch {
      // No install to inspect (e.g. a lint-only checkout); the two checks above
      // already cover what gets deployed.
      return;
    }
    expectAtOrAboveFloor(installed, "the installed node_modules/next");
  });

  it("does not configure the single-locale i18n shape CVE-2026-64642 keys on", () => {
    // Belt-and-braces on the middleware-bypass precondition. `i18n` is a Pages
    // Router option and this app is App Router only (there is no pages/ dir),
    // and production builds run webpack rather than Turbopack — so the
    // vulnerable combination is not reachable here even before the upgrade.
    // Asserted anyway because the cost is one regex and the failure it would
    // catch is an unguarded auth bypass.
    const config = readFileSync(path.join(ROOT, "next.config.mjs"), "utf8");
    expect(config).not.toMatch(/\bi18n\s*:/);
  });
});
