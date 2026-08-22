import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Transitive dependency security floors.
 *
 * Sibling of test/next-security-floor.test.ts, which guards the DIRECT `next`
 * dependency. This one guards the two packages that were found vulnerable in the
 * 2026-08 audit and are reached TRANSITIVELY, which is what makes them easy to
 * regress silently:
 *
 *   - postcss < 8.5.23 — GHSA-fxqj-rqcc-2cmp (moderate). An attacker-controlled
 *     `sourceMappingURL` reads arbitrary `.map` files when `from` is unset; an
 *     incomplete fix of GHSA-6g55-p6wh-862q. postcss is pulled in three ways
 *     here (a direct devDependency, `next`, and `tailwindcss`), and `next` pins
 *     an OLDER postcss than the fix — so the floor only holds while the
 *     `next` → `postcss` entry in package.json `overrides` holds with it. That
 *     override is the single load-bearing line, and nothing else in the suite
 *     looks at it.
 *   - undici <= 7.28.0 — five advisories, the worst High: response
 *     desynchronisation via the retry interceptor, cross-user disclosure via
 *     cache-directive parsing, CRLF injection via a blob body `type`, and cookie
 *     attribute injection. Reached only through `jsdom` (test environment), so
 *     no product code path is exposed — but a dev-tree HTTP client that
 *     desynchronises responses is still not something to leave installed.
 *
 * Expressed against the LOCKFILE, not `node_modules`, because the lockfile is
 * what `npm ci` installs in CI and in the deploy build. Every entry is checked,
 * not just the hoisted one: a nested copy at
 * `node_modules/<parent>/node_modules/postcss` installs just as readily and an
 * audit-clean top level says nothing about it.
 *
 * The regression this exists for is the one that has bitten this repo before: a
 * revert taken for an unrelated reason that happens to span package.json /
 * package-lock.json, quietly restoring a vulnerable resolution. Floors, not
 * pins — a newer patch must pass.
 */

/** Lowest non-vulnerable release, per advisory. */
const FLOORS: Record<string, string> = {
  postcss: "8.5.23", // GHSA-fxqj-rqcc-2cmp
  undici: "7.29.0", // GHSA-8xcm-r25x-g524 and four others
};

const ROOT = process.cwd();

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

const lockfile = JSON.parse(
  readFileSync(path.join(ROOT, "package-lock.json"), "utf8"),
) as { packages?: Record<string, { version?: string }> };

/**
 * Every resolved version of `name` in the lockfile, keyed by its install path —
 * the hoisted `node_modules/<name>` plus any nested copy.
 */
function resolvedVersions(name: string): Array<[string, string]> {
  return Object.entries(lockfile.packages ?? {})
    .filter(([location]) => location.endsWith(`node_modules/${name}`))
    .map(([location, entry]) => [location, entry.version ?? ""] as [string, string]);
}

describe("transitive dependency security floors", () => {
  for (const [name, floor] of Object.entries(FLOORS)) {
    it(`locks every \`${name}\` at or above ${floor}`, () => {
      const found = resolvedVersions(name);
      expect(
        found.length,
        `package-lock.json has no \`${name}\` entry at all. If it genuinely is ` +
          `no longer in the tree, drop it from FLOORS in this file rather than ` +
          `leaving a check that passes vacuously.`,
      ).toBeGreaterThan(0);

      for (const [location, version] of found) {
        expect(version, `${location} has no resolved version`).toBeTruthy();
        expect(
          compareVersions(version, floor) >= 0,
          `${location} resolves ${name} ${version}, below the patched ${floor}. ` +
            `Bump it (for postcss that means the \`next\` → \`postcss\` entry in ` +
            `package.json "overrides" as well as the devDependency range), then ` +
            `reinstall from scratch — overrides in this repo do not take effect on ` +
            `an incremental install — and commit package-lock.json.`,
        ).toBe(true);
      }
    });
  }

  it("keeps the `next` → `postcss` override that holds the postcss floor up", () => {
    // `next` depends on a postcss older than the fix and does not accept a newer
    // one by range, so without this override npm is free to install the
    // vulnerable version nested under next/ even while the top level is clean.
    const manifest = JSON.parse(
      readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as { overrides?: { next?: { postcss?: string } } };
    const override = manifest.overrides?.next?.postcss;
    expect(
      override,
      "package.json overrides.next.postcss is gone; `next` will pull its own " +
        "pinned (vulnerable) postcss back in.",
    ).toBeTruthy();
    expect(
      compareVersions(override!.replace(/^[\^~>=v]+/, ""), FLOORS.postcss) >= 0,
      `overrides.next.postcss is "${override}", which admits a postcss below ` +
        `${FLOORS.postcss}.`,
    ).toBe(true);
  });
});
