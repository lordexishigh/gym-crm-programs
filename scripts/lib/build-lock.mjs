/**
 * The lock electing a single owner of `.next`.
 *
 * `next build` DELETES `.next` before writing it, and `next dev` writes there
 * continuously, so two processes using that directory in one checkout corrupt
 * each other. Every entry point that touches `.next` therefore elects an owner
 * through this lock:
 *
 *   - scripts/postinstall.mjs — builds a missing build at install time
 *   - scripts/start.mjs       — builds/serves, or falls back to `next dev`
 *
 * Note the window that matters is precisely when BUILD_ID is ABSENT — a build in
 * flight has already removed it — so "BUILD_ID missing" cannot distinguish a
 * fresh clone from a concurrent build. Only this lock can.
 *
 * Dependency-free (node: builtins only) so it runs before any install-time
 * assumptions hold — including during `postinstall`, when node_modules may still
 * be settling.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();

/**
 * Deliberately NOT inside `.next`: `next build` deletes that directory before
 * writing, which would delete the very lock guarding the build. Waiters would
 * then see the lock vanish, conclude the builder was done, and start a competing
 * build into the directory being written. Keyed by a hash of the checkout path
 * so parallel checkouts (git worktrees, CI matrix jobs) never share a lock.
 */
export const BUILD_LOCK = path.join(
  tmpdir(),
  `alpha-crm-autobuild-${createHash("sha256").update(ROOT).digest("hex").slice(0, 16)}.lock`,
);

/** Whether `pid` is still running, used to tell a held lock from an abandoned one. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission/existence check without delivering it.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — still alive.
    return err && err.code === "EPERM";
  }
}

/**
 * The files `next start` OPENS while booting, and therefore what "a usable
 * production build" has to mean.
 *
 * BUILD_ID alone is not that, and trusting it is a defect with a very bad
 * presentation. `next start` reads BUILD_ID first and reports its absence
 * clearly (error E427, "Could not find a production build"), but immediately
 * afterwards it opens these manifests with NO such guard. Measured on this
 * project against Next 15.5.21, each of these leaves the server dead:
 *
 *     .next/prerender-manifest.json missing   ENOENT thrown out of boot
 *     .next/server/pages-manifest.json missing   ENOENT thrown out of boot
 *     routes-manifest.json written by `next dev`  TypeError:
 *                                 routesManifest.dataRoutes is not iterable
 *
 * What makes this read as an unreachable product rather than a broken build is
 * WHERE it dies. `next start` prints its full startup banner first — "▲ Next.js
 * 15.5.21", "- Local: http://localhost:3000" — and only then throws. So the log
 * looks like a server that came up, while NOTHING EVER BOUND THE PORT. An
 * unbound port black-holes the SYN instead of refusing it, so every caller waits
 * out its whole budget and every route — `/` included, static or not — reads as
 * TIMED OUT.
 *
 * The exit status is no help either. These exit NON-ZERO (1), which sounds
 * detectable, but a harness or supervisor that launches `npm start` in the
 * background and then navigates never looks at it: it sees the healthy-looking
 * banner and a port that answers nothing. An exit code only helps a caller who is
 * watching the process, which is exactly the caller that was not there.
 *
 * That state is not exotic; it is what a half-finished or partly-removed `.next`
 * looks like. `next build` writes BUILD_ID before these manifests, so an
 * interrupted build leaves exactly this. So does a disk that filled mid-build, a
 * partial copy of a checkout, or a cleanup that took some of `.next` and not all
 * of it. And it is STICKY: BUILD_ID keeps satisfying the old check, so every
 * later install skips the rebuild and every later start hands the same broken
 * directory to `next start` again. An automated review of this project reported
 * "'/' unreachable" for four consecutive rounds on precisely this shape.
 *
 * Validating the whole set closes that: a partial `.next` now reads as "no
 * build", which makes scripts/postinstall.mjs rebuild it and scripts/start.mjs
 * serve rather than die. Every entry is emitted by `next build` for this project
 * (asserted against the repo's own build in test/start-wrapper.test.ts, so this
 * list cannot silently over-require and send a GOOD build down the slow path).
 */
export const PRODUCTION_BUILD_FILES = [
  "BUILD_ID",
  "routes-manifest.json",
  "prerender-manifest.json",
  "build-manifest.json",
  "app-path-routes-manifest.json",
  "required-server-files.json",
  path.join("server", "pages-manifest.json"),
  path.join("server", "app-paths-manifest.json"),
  path.join("server", "middleware-manifest.json"),
];

/**
 * Everything wrong with `.next` as a production build, as strings worth logging —
 * empty when it is complete and correctly shaped.
 *
 * Descriptions rather than a bare boolean because the states caught here are
 * mistakable for each other and for a good build, so the log line has to say
 * WHICH it is: an absent build, a half-written one, or one a dev server
 * overwrote.
 *
 * That last case is why file existence alone is not the whole check. `next dev`
 * writes its own `.next` in the same directory, and its `routes-manifest.json`
 * omits the `dataRoutes`/`staticRoutes`/`dynamicRoutes` keys `next build`
 * produces. If a dev run and a production build interleave — a dev server killed
 * mid-write by a CI teardown, an `npm start` racing the tail of one — the
 * directory is left holding a full set of files with a DEV-shaped routes
 * manifest, and `next start` then dies on `routesManifest.dataRoutes is not
 * iterable` (observed on this project, not theorised). Detecting the shape means
 * that state gets REBUILT at install time, instead of quietly costing the
 * production path for the life of the checkout.
 */
export function buildDefects(root = ROOT) {
  const defects = [];

  for (const rel of PRODUCTION_BUILD_FILES) {
    const label = `.next/${rel.replace(/\\/g, "/")}`;
    const file = path.join(root, ".next", rel);
    try {
      if (!existsSync(file)) {
        defects.push(`${label} is missing`);
        continue;
      }
      // Empty counts as missing: a file created but not yet written is what a
      // build interrupted mid-write leaves, and `next start` fails on it too.
      if (readFileSync(file, "utf8").trim().length === 0) {
        defects.push(`${label} is empty`);
      }
    } catch (err) {
      defects.push(`${label} is unreadable (${err?.code || err})`);
    }
  }

  // Shape check, only worth running once the file is known to be present and
  // non-empty — otherwise it would report the same problem twice.
  const routesLabel = ".next/routes-manifest.json";
  if (!defects.some((d) => d.startsWith(routesLabel))) {
    try {
      const manifest = JSON.parse(
        readFileSync(path.join(root, ".next", "routes-manifest.json"), "utf8"),
      );
      if (!Array.isArray(manifest?.dataRoutes)) {
        defects.push(
          `${routesLabel} has no dataRoutes[] — it was written by \`next dev\`, ` +
            "not `next build`, and `next start` crashes on it",
        );
      }
    } catch (err) {
      defects.push(`${routesLabel} is not valid JSON (${err?.message || err})`);
    }
  }

  return defects;
}

/**
 * Whether `.next` holds a build `next start` can actually serve. See
 * `PRODUCTION_BUILD_FILES` and `buildDefects` for why this is not just a
 * BUILD_ID check.
 */
export function hasProductionBuild(root = ROOT) {
  return buildDefects(root).length === 0;
}

/**
 * Whether THIS process created the lock. Tracked because a waiter must never
 * delete the builder's lock: without this, a waiter killed by CI teardown would
 * drop a live builder's lock on its way out, and the next start would happily
 * begin a competing build into the directory being written.
 */
let ownsBuildLock = false;

/**
 * Try to become the process that owns `.next`. `wx` makes create-or-fail atomic
 * at the filesystem level, so two processes racing here cannot both win.
 * Returns true if this process now owns the lock.
 */
export function acquireBuildLock() {
  try {
    // Normally tmpdir, which exists; recursive keeps this safe on an exotic TMPDIR.
    mkdirSync(path.dirname(BUILD_LOCK), { recursive: true });
    writeFileSync(BUILD_LOCK, JSON.stringify({ pid: process.pid }), { flag: "wx" });
    ownsBuildLock = true;
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") return false;
    // Any other failure (read-only mount, permissions) must not block serving:
    // fall through to building unlocked rather than refusing to start.
    console.error(`[start] could not create build lock (${err?.code || err}); building unlocked.`);
    return true;
  }
}

/** Delete the lock file whoever owns it — only for reclaiming a stale one. */
export function removeBuildLock() {
  try {
    rmSync(BUILD_LOCK, { force: true });
  } catch {
    /* best effort — a leftover lock is reclaimed as stale by the next start */
  }
}

/**
 * Release the lock, but ONLY if this process holds it. Safe to call
 * unconditionally (signal handlers do), and never throws.
 */
export function releaseBuildLock() {
  if (!ownsBuildLock) return;
  ownsBuildLock = false;
  removeBuildLock();
}

/**
 * Whoever currently holds the lock, or null if it is gone/unreadable. A lock
 * whose owner is dead is STALE: a build killed partway through (CI teardown,
 * Ctrl-C, OOM) leaves both the lock and a `.next` with no BUILD_ID, and without
 * reclaiming it every later start would wait out its budget for a build that is
 * never coming.
 */
export function readBuildLock() {
  try {
    const { pid } = JSON.parse(readFileSync(BUILD_LOCK, "utf8"));
    return { pid, alive: pidAlive(pid) };
  } catch {
    return null;
  }
}

/** Whether the lock file exists at all, regardless of whether it can be read. */
export function buildLockExists() {
  return existsSync(BUILD_LOCK);
}

/** Whether some other process owns `.next` right now. */
export function buildInFlight() {
  const holder = readBuildLock();
  return Boolean(holder && holder.alive && holder.pid !== process.pid);
}
