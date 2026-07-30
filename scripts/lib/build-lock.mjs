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
 * A usable production build is `.next/BUILD_ID`. Checking the directory alone is
 * not enough: a build that was interrupted, or a `.next` left behind by
 * `next dev`, has the directory but no BUILD_ID, and `next start` rejects it.
 */
export function hasProductionBuild(root = ROOT) {
  const buildId = path.join(root, ".next", "BUILD_ID");
  try {
    return existsSync(buildId) && readFileSync(buildId, "utf8").trim().length > 0;
  } catch {
    return false;
  }
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
