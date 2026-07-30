#!/usr/bin/env node
/**
 * Produce a production build at INSTALL time when the checkout has none
 * (`postinstall`).
 *
 * WHY THIS EXISTS
 *
 * `.next/` is gitignored, so a fresh clone has no production build. Every
 * automated review harness clones, installs, runs `npm start`, and then navigates
 * — and a navigation gets a fixed budget (20s in the harness that reported this).
 * Measured on this project:
 *
 *     production build present  →  `/` served 720ms after launch
 *     no production build       →  `/` served  20s  after launch
 *
 * The 20s is not slack that can be trimmed: it is the first webpack/Turbopack
 * compile, which `next dev` pays on the first request to a route and which no
 * amount of readiness-gating can remove. It lands exactly on the harness's 20s
 * budget, so the result is a coin flip, which is why "goto '/' timed out" kept
 * coming back round after round while the app was in fact fine. scripts/start.mjs
 * documents the several attempts to make the UNBUILT path fast enough; the floor
 * is the compile.
 *
 * So the build is moved to where waiting for it is free. During `npm install`
 * nothing is listening on a port and no client is waiting on one, so 67s of build
 * is invisible; during `npm start` the same 67s is a port that black-holes every
 * connection. Same work, and the difference between "slow install" and "the
 * product is unreachable".
 *
 * WHAT IT MUST NEVER DO
 *
 * Break an install. Every failure path below warns and exits 0: `npm start`
 * retains its own `next dev` fallback, so a skipped build costs latency, never
 * function. It is also skipped whenever building would be wrong or wasted —
 * see `decideBuild`, which is where all of that policy lives and is unit-tested.
 *
 * Dependency-free (node: builtins only): `postinstall` runs while node_modules is
 * still settling, so nothing here may assume an installed package.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  acquireBuildLock,
  buildInFlight,
  hasProductionBuild,
  releaseBuildLock,
} from "./lib/build-lock.mjs";
// The single list of packages without which nothing renders, shared with
// scripts/start.mjs so an install-time skip and a start-time refusal can never
// disagree about what "cannot build" means.
import { missingRenderDeps } from "./lib/dev-server.mjs";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();

/** Treat an empty string as unset, so a CI step can clear an inherited value. */
function isSet(value) {
  return typeof value === "string" && value.trim() !== "" && value !== "0" && value !== "false";
}

/**
 * Whether the toolchain needed for `next build` is actually installed.
 *
 * Tailwind, PostCSS, autoprefixer and typescript are devDependencies, so an
 * install run with `--omit=dev` (or NODE_ENV=production, which npm treats the
 * same way) cannot build. Attempting it there would fail noisily on every
 * production install for no benefit.
 *
 * Note what skipping does NOT buy: such a tree cannot be served by the `next dev`
 * fallback either, so the app is not merely unbuilt, it is unrenderable. The
 * committed `.npmrc` (include=dev) exists to stop that install from happening at
 * all; `npm start` refuses to start if it happened anyway.
 */
function buildToolchainPresent() {
  // Resolved from the shared list in scripts/lib/dev-server.mjs, so this and the
  // start-time preflight cannot drift apart.
  return missingRenderDeps().length === 0;
}

/**
 * Decide whether this install should build, and say why either way.
 *
 * Pure and injectable so the policy — not a real 67s build — is what the tests
 * exercise. Returns `{ build, reason }`; `reason` is logged verbatim.
 */
export function decideBuild({
  env = process.env,
  built = hasProductionBuild(ROOT),
  toolchain = buildToolchainPresent(),
  locked = buildInFlight(),
} = {}) {
  // Explicit opt-out, for pipelines that build in their own named step (CI does)
  // and would otherwise pay for two identical builds.
  if (isSet(env.ALPHA_SKIP_BUILD)) {
    return { build: false, reason: "ALPHA_SKIP_BUILD is set — skipping the install-time build." };
  }

  // Vercel (and any platform that builds after installing) runs `next build`
  // itself, with the deployment's env rather than the install's. Building twice
  // doubles deploy time and the first one is thrown away.
  if (isSet(env.VERCEL) || isSet(env.VERCEL_ENV)) {
    return { build: false, reason: "Running on Vercel, which builds after install — skipping." };
  }

  // A global install has no project to build.
  if (isSet(env.npm_config_global)) {
    return { build: false, reason: "Global install — nothing to build." };
  }

  if (!toolchain) {
    return {
      build: false,
      reason:
        "devDependencies are absent (--omit=dev / NODE_ENV=production), so " +
        "`next build` cannot run — skipping. WARNING: this tree cannot render a " +
        "page at all — tailwindcss/autoprefixer/typescript are required to compile " +
        "every route, so `npm start`'s `next dev` fallback cannot serve it either " +
        "and it will refuse to start. Reinstall with `npm install --include=dev` " +
        "(the committed .npmrc does this unless overridden).",
    };
  }

  // Cheap and by far the most common case on a developer machine: repeat
  // installs must not each pay for a build that already exists.
  if (built) {
    return { build: false, reason: "A production build already exists (.next/BUILD_ID) — skipping." };
  }

  // Another process owns `.next` — a concurrent `npm start`, dev server or build.
  // Deliberately NOT waited out: `npm start`'s dev fallback holds this lock for
  // its whole lifetime, and an install that blocked on it would appear to hang
  // for as long as that server runs.
  if (locked) {
    return {
      build: false,
      reason:
        "Another process is using .next right now (a build, or a dev server) — " +
        "skipping rather than writing underneath it.",
    };
  }

  return { build: true, reason: "No production build found (.next/BUILD_ID is missing)." };
}

/** Run `next build`, inheriting stdio so its output is part of the install log. */
function runBuild() {
  return new Promise((resolve) => {
    let bin;
    try {
      bin = require.resolve("next/dist/bin/next");
    } catch {
      // `next` itself is unresolvable — an install that did not complete, or a
      // tree without dependencies. Nothing to do, and not our failure to report.
      resolve(false);
      return;
    }
    const child = spawn(process.execPath, [bin, "build"], {
      cwd: ROOT,
      // NEXT_TELEMETRY_DISABLED keeps an install from making a network call it
      // was never asked to make (and from stalling on one in a sandbox).
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: "inherit",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function main() {
  const { build, reason } = decideBuild();
  if (!build) {
    console.log(`[postinstall] ${reason}`);
    return;
  }

  // Own `.next` for the duration. `decideBuild` already found the lock free; a
  // failed acquire here means another process took it in between, which is
  // exactly the case to yield on rather than race.
  if (!acquireBuildLock()) {
    console.log("[postinstall] Another process took .next first — skipping the build.");
    return;
  }

  try {
    console.log(
      `[postinstall] ${reason} Building now, while nothing is waiting on a port.\n` +
        "[postinstall] This takes ~1 minute and makes `npm start` serve the real " +
        "production build immediately. Without it `npm start` falls back to " +
        "`next dev`, which needs ~20s to compile and serve `/` — long enough for a " +
        "browser or QA harness to time out and report the whole app as unreachable.\n" +
        "[postinstall] Set ALPHA_SKIP_BUILD=1 to skip this (CI does; it builds in " +
        "its own step).",
    );
    const ok = await runBuild();
    if (ok) {
      console.log("[postinstall] Production build ready — `npm start` will serve it directly.");
    } else {
      // Never fail the install over this. `npm start` still serves, via `next dev`.
      console.warn(
        "[postinstall] `next build` did not succeed. The install itself is fine — " +
          "`npm start` will fall back to `next dev` (slower first response). Run " +
          "`npm run build` to see the full error.",
      );
    }
  } finally {
    releaseBuildLock();
  }
}

/**
 * Whether this file is being RUN, as opposed to imported.
 *
 * The unit tests import `decideBuild` from here, and without this guard that
 * import would run `main()` — kicking off a real 67s `next build` inside the test
 * suite. Compared through `realpathSync` so a symlinked or junctioned checkout
 * (npm link, a Windows junction, a git worktree) still matches.
 */
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  const resolve = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (invokedDirectly()) {
  // Last-resort release: covers exits that bypass the `finally` in `main`.
  process.on("exit", releaseBuildLock);

  main().catch((err) => {
    // An unexpected throw here must still not break `npm install`.
    console.warn(`[postinstall] skipped after an unexpected error: ${err?.message || err}`);
  });
}
