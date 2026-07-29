#!/usr/bin/env node
/**
 * Production start wrapper (`npm start`).
 *
 * `next start` has two failure modes that both present to a browser as "the
 * entire product is unreachable" rather than as an error anyone can act on:
 *
 *   1. NO PRODUCTION BUILD. `.next/` is gitignored, so a fresh clone that runs
 *      `npm start` without `npm run build` gets an immediate exit. Nothing ever
 *      binds the port. A client that reaches the host through a forwarded port,
 *      container or proxy does not receive a TCP reset for an unbound port — the
 *      SYN is simply black-holed — so the navigation hangs until the client's own
 *      budget expires. That is indistinguishable from a hung server: every route
 *      "times out", including fully static ones like `/` and `/login`.
 *
 *      So this is REPAIRED, not merely reported. But the repair has to be fast,
 *      and building first is not: `next build` on this project takes ~85s
 *      (measured, cold). An earlier revision built the missing build, which fixed
 *      the end state and not the symptom — for those 85 seconds the port is still
 *      unbound, so a browser, probe or reviewer pointed at it still waits out its
 *      entire budget and still concludes the product is unreachable. Building
 *      silently and refusing to serve are the same observable event.
 *
 *      What serves the REAL pages an order of magnitude sooner is `next dev`
 *      (measured: `/` served at ~19s against a build's ~85s+), so that is the
 *      fallback: no build, no placeholder page. A placeholder that answers
 *      instantly was tried and is worse than it looks: the port responds, so
 *      callers stop waiting and start testing, and every one of them then judges
 *      a page that has none of the product on it.
 *
 *      The dev server is run through scripts/lib/dev-server.mjs, which withholds
 *      the port until a request has actually been served on it — `next dev`
 *      otherwise binds at ~3s and cannot render `/` for another ~14s, which is
 *      the same "open but unresponsive" trap in a smaller form.
 *
 *      Dev mode is announced loudly, never silent: responses are slower and this
 *      is not how production should run. Production doesn't take this path —
 *      Vercel builds, and CI builds before starting, so `.next/BUILD_ID` exists
 *      and `next start` serves it. Opt out with START_AUTOBUILD=0 to restore the
 *      fail-fast for callers that manage their own builds. See `ensureServable`.
 *
 *      Concurrency is the one hazard the fallback shares with a build: both write
 *      `.next`, and `next build` DELETES that directory before writing it, so a
 *      build running in ANOTHER process corrupts whatever this one is doing (and
 *      vice versa). Note that the dangerous window is precisely when BUILD_ID is
 *      absent — a build in flight has already removed it — so "BUILD_ID missing"
 *      cannot distinguish a fresh clone from a concurrent build. A lock file
 *      does, and that is what guards this: starts elect ONE owner of `.next`
 *      while the rest wait for it.
 *
 *   2. PORT ALREADY IN USE. `next start` fails deep in its own stack with a raw
 *      EADDRINUSE and exits. Whatever is already on that port — commonly an
 *      orphaned server from an earlier run, serving an OLDER build — keeps
 *      answering, so the run silently probes the wrong process and any result it
 *      produces is about stale code.
 *
 * This wrapper turns both into something deterministic: it refuses to start
 * without a usable production build, naming the remedy, and it refuses to hand
 * the port to `next start` when another process already holds it, naming that
 * process instead of failing anonymously.
 *
 * Everything here is dependency-free (node: builtins only) so it runs before any
 * install-time assumptions hold.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
// The dev-mode fallback below is the same server `npm run dev` runs, gate and
// all: shared rather than duplicated so a checkout with no build is served
// exactly as well as one being developed. See scripts/lib/dev-server.mjs.
import {
  describePortHolder,
  disabled,
  portInUse,
  resolveHost,
  resolvePort,
  serveDev,
  stopDev,
} from "./lib/dev-server.mjs";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const NEXT_BIN = require.resolve("next/dist/bin/next");

/**
 * Lock electing a single owner of `.next` among concurrent `npm start`
 * invocations — a builder, or a dev-mode fallback server, which also writes
 * there.
 *
 * Deliberately NOT inside `.next`: `next build` deletes that directory before
 * writing, which would delete the very lock guarding the build. Waiters would
 * then see the lock vanish, conclude the builder was done, and start a competing
 * build into the directory being written. Keyed by a hash of the checkout path
 * so parallel checkouts (git worktrees, CI matrix jobs) never share a lock.
 */
const BUILD_LOCK = path.join(
  tmpdir(),
  `alpha-crm-autobuild-${createHash("sha256").update(ROOT).digest("hex").slice(0, 16)}.lock`,
);

/**
 * Ceiling on how long to wait for ANOTHER process's build to land before giving
 * up. Generous (builds are minutes, not seconds) but finite: an indefinite wait
 * would reintroduce the very hang this wrapper exists to remove.
 */
const BUILD_WAIT_MS = Number(process.env.START_BUILD_WAIT_MS) || 600_000;

/** Whether `pid` is still running, used to tell a held lock from an abandoned one. */
function pidAlive(pid) {
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
function hasProductionBuild() {
  const buildId = path.join(ROOT, ".next", "BUILD_ID");
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
 * Try to become the process that runs the autobuild. `wx` makes create-or-fail
 * atomic at the filesystem level, so two starts racing here cannot both win.
 * Returns true if this process now owns the lock.
 */
function acquireBuildLock() {
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
function removeBuildLock() {
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
function releaseBuildLock() {
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
function readBuildLock() {
  try {
    const { pid } = JSON.parse(readFileSync(BUILD_LOCK, "utf8"));
    return { pid, alive: pidAlive(pid) };
  } catch {
    return null;
  }
}

/** Resolve after `ms`, without pulling in a timers/promises import. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether some other process is running a build right now. */
function buildInFlight() {
  const holder = readBuildLock();
  return Boolean(holder && holder.alive && holder.pid !== process.pid);
}

/**
 * Decide how this checkout can be served, and make it servable.
 *
 * Returns the mode to serve in — `"start"` when a usable production build
 * exists, `"dev"` when there is none and the dev-mode fallback should serve
 * instead — or `null` after reporting why it cannot be served at all.
 *
 * The subtle part is what counts as "a build is ready". `.next/BUILD_ID` is NOT
 * a sufficient signal for a CONCURRENT observer: `next build` writes BUILD_ID
 * before it writes the manifests `next start` opens, so a start that races a
 * build sees BUILD_ID, launches, and dies on a missing
 * `.next/prerender-manifest.json`. (Observed, not theorised.) The authoritative
 * "the build is finished" signal is the builder RELEASING THE LOCK, so every
 * wait here ends on lock acquisition and never on BUILD_ID appearing.
 */
async function ensureServable() {
  // Fast path, and the overwhelmingly common one: a finished build with no
  // builder running. The in-flight test is what keeps this off the race above.
  if (hasProductionBuild() && !buildInFlight()) return "start";

  // Wait out any in-flight build, reclaiming a lock whose owner died. Opting out
  // of the fallback does not opt out of waiting: serving a half-written `.next`
  // is exactly what we are avoiding.
  let waited = 0;
  while (!acquireBuildLock()) {
    const holder = readBuildLock();
    if (!holder) {
      // Either the lock was just released or it is unreadable/truncated — a
      // writer killed between create and write. An unreadable lock that still
      // EXISTS must be removed, or `readBuildLock` keeps returning null while
      // `acquireBuildLock` keeps failing on EEXIST: a hot spin forever.
      if (existsSync(BUILD_LOCK)) {
        console.error("[start] Removing unreadable build lock.");
        removeBuildLock();
      }
      continue;
    }
    if (!holder.alive) {
      console.error(
        `[start] Reclaiming stale build lock from dead PID ${holder.pid} ` +
          "(a previous build was interrupted).",
      );
      removeBuildLock();
      continue;
    }
    if (waited === 0) {
      console.log(
        `[start] Another process (PID ${holder.pid}) is building or serving this ` +
          "checkout; waiting for it to finish rather than writing .next underneath it.",
      );
    }
    if (waited >= BUILD_WAIT_MS) {
      console.error(
        `[start] Timed out after ${Math.round(BUILD_WAIT_MS / 1000)}s waiting for ` +
          `PID ${holder.pid} to release .next. Not starting: serving a ` +
          "partially-written .next would fail on a missing manifest.\n" +
          "[start] Stop that process and run `npm run build`, or raise " +
          "START_BUILD_WAIT_MS.",
      );
      return null;
    }
    await delay(1_000);
    waited += 1_000;
  }

  // Lock held, so no build can be in flight. Anything on disk now is complete.
  let mode = null;
  try {
    if (hasProductionBuild()) {
      mode = "start";
      return mode;
    }

    // Explicit opt-out: preserve the fail-fast for callers that manage their own
    // builds and would rather hear about a missing one than have one improvised.
    if (disabled(process.env.START_AUTOBUILD)) {
      console.error(
        "[start] No production build found (.next/BUILD_ID is missing) and " +
          "START_AUTOBUILD=0; `next start` would exit and nothing would ever bind " +
          "this port.\n[start] Run `npm run build` first, then `npm start`.",
      );
      return null;
    }

    console.warn(
      "[start] No production build found (.next/BUILD_ID is missing) — serving " +
        "with `next dev` instead, and opening this port only once it can answer.\n" +
        "[start] Why not build first: `next build` takes ~85s on this project, " +
        "and for every one of those seconds the port stays UNBOUND. An unbound " +
        "port black-holes the connection instead of refusing it, so callers wait " +
        "out their whole budget and every route — even static ones like / and " +
        "/login — reads as timed out.\n" +
        "[start] Expect roughly 15-20s before the port opens: that is `/` being " +
        "compiled. The port stays shut until it has actually been served, so " +
        "\"open\" means usable and a readiness loop cannot be waved through into a " +
        "navigation that then times out.\n" +
        "[start] This is a DEVELOPMENT server: the pages are real and complete, " +
        "the responses are slower. For a production server run `npm run build` " +
        "first; `npm start` then serves that build directly. START_AUTOBUILD=0 " +
        "makes a missing build a hard failure instead.",
    );
    // The lock is deliberately NOT released for this mode: the dev server keeps
    // writing `.next` for as long as it runs, so it stays the owner. Released by
    // the exit/signal handlers in `main`.
    mode = "dev";
    return mode;
  } finally {
    if (mode !== "dev") releaseBuildLock();
  }
}

/**
 * The `next start` child this wrapper is responsible for, tracked so a signal
 * handler can reap it. A dev-mode child belongs to scripts/lib/dev-server.mjs
 * and is reaped through its `stopDev`.
 */
let activeChild = null;

/** Spawn a `next` subcommand, recording it as the child to reap on a signal. */
function spawnNext(args, extraEnv = {}) {
  activeChild = spawn(process.execPath, [NEXT_BIN, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });
  return activeChild;
}

async function main() {
  // Everything after `--` (or any extra argv) is forwarded to `next start`.
  const forwarded = process.argv.slice(2).filter((a) => a !== "--");
  const port = resolvePort(forwarded);
  const host = resolveHost(forwarded);

  // Forward signals to whichever `next` child is live, so it is actually reaped
  // on Ctrl-C / CI teardown. An orphaned dev server matters twice over: it keeps
  // the port (the next run then probes a stale process) and it keeps mutating
  // `.next`, which breaks whatever command runs next.
  const forward = (signal) => () => {
    // Reaps a dev-mode server and its readiness forwarder; a no-op otherwise.
    stopDev(signal);
    if (activeChild && !activeChild.killed) activeChild.kill(signal);
    // If we were interrupted while owning the lock, drop it now so the next start
    // proceeds immediately instead of waiting on our dead PID.
    releaseBuildLock();
  };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));

  // 1. Refuse to start onto an occupied port, FIRST — before any waiting or
  //    fallback work. Without this the run would keep talking to whatever is
  //    already there, usually an orphaned server from a previous run serving an
  //    older build, and every result would silently be about stale code.
  if (await portInUse(port, host)) {
    const holder = await describePortHolder(port);
    console.error(
      `[start] Port ${port} is already in use${holder}.\n` +
        "[start] Refusing to start: the existing process would keep answering on " +
        "this port and may be serving an older build.\n" +
        `[start] Stop it first, or start on a different port: \`npm start -- -p <port>\`.`,
    );
    process.exit(1);
  }

  // 2. Guarantee there is something to serve, SOON. A missing build falls back to
  //    `next dev` rather than being built first, because a client cannot tell an
  //    85-second build from a hung server: an unbound port black-holes the SYN,
  //    so `/`, `/login` and `/portal/login` all "time out" and the product reads
  //    as unreachable for the entire build. Concurrent use of `.next` by another
  //    build/e2e/smoke run is handled by a lock. See `ensureServable`.
  const mode = await ensureServable();
  if (!mode) process.exit(1);

  // 3. Hand off to `next`. The signal handlers installed above now target the
  //    server, so it is reaped on Ctrl-C / CI teardown instead of being orphaned
  //    onto the port.
  if (mode === "dev") {
    // Arguments are deliberately NOT forwarded: `next start`-only flags
    // (--keepAliveTimeout and friends) would be rejected by `next dev`, and the
    // port/host were resolved above from exactly those arguments.
    //
    // START_DEV_FALLBACK tells next.config.mjs to drop the dev-tools indicator:
    // this server is standing in for the real one, and a debug badge floating
    // over every page is not part of the product.
    const { code, signal } = await serveDev({
      port,
      host,
      env: { START_DEV_FALLBACK: "1" },
    });
    // The lock is held for the dev server's lifetime, so it must be dropped when
    // that ends — otherwise the next start waits out its whole budget on a PID
    // that is already gone.
    releaseBuildLock();
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
    return;
  }

  const args = ["start", ...forwarded];
  if (!forwarded.some((a) => a === "-p" || a === "--port" || a.startsWith("--port="))) {
    args.push("-p", String(port));
  }

  const server = spawnNext(args);

  server.on("error", (err) => {
    console.error("[start] failed to launch `next start`:", err);
    process.exit(1);
  });
  server.on("close", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

// Last-resort release: covers exits that bypass the handlers above (an uncaught
// throw, process.exit elsewhere). Never throws; a leftover lock would otherwise
// be reclaimed as stale only after the next start reads a dead PID.
process.on("exit", releaseBuildLock);

main().catch((err) => {
  console.error("[start] unexpected failure:", err);
  process.exit(1);
});
