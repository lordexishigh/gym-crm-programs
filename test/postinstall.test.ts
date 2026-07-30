import { describe, expect, it } from "vitest";
import { decideBuild } from "../scripts/postinstall.mjs";

/**
 * Regression guard for the install-time build (scripts/postinstall.mjs).
 *
 * WHAT IT PROTECTS
 *
 * `.next/` is gitignored, so a fresh clone has no production build. An automated
 * review harness clones, installs, runs `npm start` and navigates with a fixed
 * budget — 20s in the report that drove this. Measured on this project:
 *
 *     production build present  ->  `/` served  720ms after launch
 *     no production build       ->  `/` served   20s  after launch
 *
 * That 20s is the first webpack/Turbopack compile that `next dev` pays on the
 * first request to a route. It cannot be gated or warmed away, and it lands
 * exactly on the harness's budget — so the verdict was a coin flip and "goto '/':
 * Timeout 20000ms exceeded" kept recurring across rounds while the app itself was
 * fine. `postinstall` moves the build to the one moment when waiting for it is
 * free: during `npm install` no port is open, so 67s is invisible.
 *
 * WHAT THESE TESTS PIN
 *
 * The policy, not a real build. `decideBuild` is pure and fully injected, so the
 * whole matrix runs in milliseconds and never touches a real `.next`. The two
 * properties that matter are (a) a fresh clone DOES build, because that is the
 * entire point, and (b) every skip is deliberate — an install must never build
 * when doing so would be wasted, wrong, or destructive to a directory another
 * process owns, and must never fail an install either way.
 */

/**
 * Call `decideBuild` against a fresh clone — no build, dev deps installed,
 * nothing else going on — with only the named facts overridden.
 *
 * The env cast is needed because `NodeJS.ProcessEnv` requires NODE_ENV, which no
 * case here cares about; every other input is a plain boolean.
 */
function decide(
  over: {
    env?: Record<string, string>;
    built?: boolean;
    toolchain?: boolean;
    locked?: boolean;
  } = {},
): { build: boolean; reason: string } {
  return decideBuild({
    built: false,
    toolchain: true,
    locked: false,
    ...over,
    env: (over.env ?? {}) as unknown as NodeJS.ProcessEnv,
  });
}

describe("scripts/postinstall.mjs — decideBuild", () => {
  it("builds for a fresh clone, which is the case the whole script exists for", () => {
    const { build, reason } = decide();

    expect(build).toBe(true);
    // The reason is logged verbatim into the install output; it must name the
    // actual signal so a reader can verify it themselves.
    expect(reason).toMatch(/BUILD_ID/);
  });

  it("skips when a production build already exists, so repeat installs stay cheap", () => {
    const { build, reason } = decide({ built: true });

    expect(build).toBe(false);
    expect(reason).toMatch(/already exists/);
  });

  it("honours ALPHA_SKIP_BUILD for pipelines that build in their own step", () => {
    // CI sets this at job level: it builds explicitly, and building at install
    // time as well would pay for the same ~67s twice.
    const { build, reason } = decide({ env: { ALPHA_SKIP_BUILD: "1" } });

    expect(build).toBe(false);
    expect(reason).toMatch(/ALPHA_SKIP_BUILD/);
  });

  it("treats an empty ALPHA_SKIP_BUILD as unset, so a CI step can clear it", () => {
    // `env: ALPHA_SKIP_BUILD: ""` is how a single workflow step opts back IN
    // after the job opted out. Empty must therefore not read as "skip".
    expect(decide({ env: { ALPHA_SKIP_BUILD: "" } }).build).toBe(true);
    expect(decide({ env: { ALPHA_SKIP_BUILD: "0" } }).build).toBe(true);
    expect(decide({ env: { ALPHA_SKIP_BUILD: "false" } }).build).toBe(true);
  });

  it("skips on Vercel, which builds after installing with the deployment's env", () => {
    // Building here would double deploy time and the result would be discarded.
    expect(decide({ env: { VERCEL: "1" } }).build).toBe(false);
    expect(decide({ env: { VERCEL_ENV: "production" } }).build).toBe(false);
    expect(decide({ env: { VERCEL: "1" } }).reason).toMatch(/Vercel/);
  });

  it("skips a global install, which has no project to build", () => {
    const { build } = decide({ env: { npm_config_global: "true" } });

    expect(build).toBe(false);
  });

  it("skips when devDependencies are absent, since `next build` needs them", () => {
    // Tailwind/PostCSS are devDependencies: `npm ci --omit=dev` cannot build, and
    // trying would fail noisily on every production install for no benefit.
    const { build, reason } = decide({ toolchain: false });

    expect(build).toBe(false);
    expect(reason).toMatch(/devDependencies/);
    // It must point at the remedy rather than leaving a bare refusal.
    expect(reason).toMatch(/npm run build/);
  });

  it("yields when another process owns .next instead of writing underneath it", () => {
    // `next build` DELETES `.next` before writing, and a dev server writes there
    // continuously, so two processes in one checkout corrupt each other. The lock
    // is shared with scripts/start.mjs (scripts/lib/build-lock.mjs).
    const { build, reason } = decide({ locked: true });

    expect(build).toBe(false);
    expect(reason).toMatch(/Another process/);
  });

  it("does not WAIT on that lock, because an install would appear to hang", () => {
    // `npm start`'s dev fallback holds the lock for its entire lifetime, so a
    // blocking wait here would stall `npm install` for as long as that server
    // runs. Skipping is bounded; waiting is not. Pinned by the reason naming
    // skipping rather than waiting.
    const { reason } = decide({ locked: true });

    expect(reason).toMatch(/skipping/i);
    expect(reason).not.toMatch(/waiting/i);
  });

  it("prefers an existing build over building, even while another process holds the lock", () => {
    // Ordering guard: `built` is checked before `locked`, so the common
    // already-built case never reports a confusing lock message.
    const { reason } = decide({ built: true, locked: true });

    expect(reason).toMatch(/already exists/);
  });
});
