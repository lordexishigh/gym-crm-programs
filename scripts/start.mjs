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
 *      So this is REPAIRED, not merely reported: a missing build is built. An
 *      earlier revision only logged the remedy and exited, which fixes nothing
 *      for the caller that matters — a browser, probe or reviewer pointed at the
 *      port still waits out its whole budget and still concludes the product is
 *      unreachable. Refusing to serve and hanging are the same observable event;
 *      only actually serving is different.
 *
 *      The hazard that made this opt-in is real but narrower than "don't build":
 *      `next build` DELETES `.next` before writing, so a build started while
 *      ANOTHER build/e2e/smoke run is using that directory corrupts it. Note
 *      that the dangerous window is precisely when BUILD_ID is absent — a build
 *      in flight has already removed it — so "BUILD_ID missing" cannot
 *      distinguish a fresh clone from a concurrent build. A lock file does, and
 *      that is what guards this now: concurrent starts elect ONE builder and the
 *      rest wait for its output. Opt out with START_AUTOBUILD=0 to restore the
 *      old fail-fast. See `ensureProductionBuild`.
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
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const NEXT_BIN = require.resolve("next/dist/bin/next");

/**
 * Lock electing a single autobuilder among concurrent `npm start` invocations.
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

/** Explicit opt-OUT check. Only an explicit falsy value disables a default-on flag. */
function disabled(value) {
  return value === "0" || value === "false";
}

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
 * Resolve the port the same way `next start` does, so the preflight check and
 * the server can never disagree: an explicit `-p/--port` flag wins, then `PORT`,
 * then Next's own default of 3000.
 */
function resolvePort(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-p" || arg === "--port") {
      const next = argv[i + 1];
      if (next && /^\d+$/.test(next)) return Number(next);
    }
    const inline = /^--port=(\d+)$/.exec(arg);
    if (inline) return Number(inline[1]);
  }
  if (process.env.PORT && /^\d+$/.test(process.env.PORT)) {
    return Number(process.env.PORT);
  }
  return 3000;
}

/** The hostname `next start` will bind, mirroring its own flag handling. */
function resolveHost(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "-H" || argv[i] === "--hostname") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) return next;
    }
    const inline = /^--hostname=(.+)$/.exec(argv[i]);
    if (inline) return inline[1];
  }
  return process.env.HOSTNAME || "0.0.0.0";
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
 * Ensure a servable production build exists, building one if not.
 *
 * Returns true if the caller may proceed to serve; false only after reporting
 * why it may not.
 *
 * The subtle part is what counts as "a build is ready". `.next/BUILD_ID` is NOT
 * a sufficient signal for a CONCURRENT observer: `next build` writes BUILD_ID
 * before it writes the manifests `next start` opens, so a start that races a
 * build sees BUILD_ID, launches, and dies on a missing
 * `.next/prerender-manifest.json`. (Observed, not theorised.) The authoritative
 * "the build is finished" signal is the builder RELEASING THE LOCK, so every
 * wait here ends on lock acquisition and never on BUILD_ID appearing.
 */
async function ensureProductionBuild() {
  // Fast path, and the overwhelmingly common one: a finished build with no
  // builder running. The in-flight test is what keeps this off the race above.
  if (hasProductionBuild() && !buildInFlight()) return true;

  // Wait out any in-flight build, reclaiming a lock whose owner died. Opting out
  // of AUTOBUILD does not opt out of waiting: waiting for someone else's build is
  // not building, and serving a half-written `.next` is what we are avoiding.
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
        `[start] Another process (PID ${holder.pid}) is building; waiting for it ` +
          "to finish rather than starting a competing build.",
      );
    }
    if (waited >= BUILD_WAIT_MS) {
      console.error(
        `[start] Timed out after ${Math.round(BUILD_WAIT_MS / 1000)}s waiting for ` +
          `PID ${holder.pid} to finish building. Not starting: serving a ` +
          "partially-written .next would fail on a missing manifest.\n" +
          "[start] Stop that process and run `npm run build`, or raise " +
          "START_BUILD_WAIT_MS.",
      );
      return false;
    }
    await delay(1_000);
    waited += 1_000;
  }

  // Lock held, so no build can be in flight. Anything on disk now is complete.
  try {
    if (hasProductionBuild()) return true;

    // Explicit opt-out: preserve the fail-fast for callers that manage their own
    // builds and would rather hear about a missing one than wait for it.
    if (disabled(process.env.START_AUTOBUILD)) {
      console.error(
        "[start] No production build found (.next/BUILD_ID is missing) and " +
          "START_AUTOBUILD=0; `next start` would exit and nothing would ever bind " +
          "this port.\n[start] Run `npm run build` first, then `npm start`.",
      );
      return false;
    }

    console.log(
      "[start] No production build found (.next/BUILD_ID is missing) — running " +
        "`next build` first so the server has something to serve. " +
        "(START_AUTOBUILD=0 to fail instead.)",
    );
    const code = await runNext(["build"]);
    if (code !== 0) {
      console.error(`[start] build failed with exit code ${code}; not starting.`);
      return false;
    }
    if (!hasProductionBuild()) {
      console.error("[start] build reported success but .next/BUILD_ID is still missing.");
      return false;
    }
    return true;
  } finally {
    releaseBuildLock();
  }
}

/**
 * The `next` child this wrapper is currently responsible for — a build, then
 * the server. Tracked so signal handlers can reap whichever one is live.
 */
let activeChild = null;

/** Spawn a `next` subcommand, recording it as the child to reap on a signal. */
function spawnNext(args) {
  activeChild = spawn(process.execPath, [NEXT_BIN, ...args], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });
  return activeChild;
}

/** Run a `next` subcommand to completion; resolves with its exit code. */
function runNext(args) {
  return new Promise((resolve) => {
    const child = spawnNext(args);
    child.on("error", (err) => {
      console.error(`[start] could not run \`next ${args.join(" ")}\`:`, err);
      resolve(-1);
    });
    // A child killed by a signal reports code `null`; treat that as failure so a
    // torn-down build is never mistaken for a successful one.
    child.on("close", (code) => resolve(code ?? -1));
  });
}

/**
 * Probe whether `port` can actually be bound, rather than assuming it is free.
 * Binds the same host `next start` will use so the answer reflects the real
 * conflict (a server on 0.0.0.0 does conflict with one on 127.0.0.1).
 */
function portInUse(port, host) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (err) => {
      probe.close();
      resolve(err && err.code === "EADDRINUSE");
    });
    probe.once("listening", () => probe.close(() => resolve(false)));
    // `next start` binds all interfaces for 0.0.0.0; mirror that.
    if (host === "0.0.0.0" || host === "::") probe.listen(port);
    else probe.listen(port, host);
  });
}

/**
 * Best-effort identification of whoever holds the port, so the operator gets a
 * name and a PID instead of just "in use". Platform-specific and entirely
 * optional — any failure degrades to no extra detail.
 */
function describePortHolder(port) {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const cmd = isWindows
      ? { file: "netstat", args: ["-ano", "-p", "TCP"] }
      : { file: "lsof", args: ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"] };

    let out = "";
    let child;
    try {
      child = spawn(cmd.file, cmd.args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve("");
      return;
    }
    const done = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      done("");
    }, 3_000);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => done(""));
    child.on("close", () => {
      const lines = out
        .split(/\r?\n/)
        .filter((l) =>
          isWindows ? /LISTENING/.test(l) && l.includes(`:${port}`) : /LISTEN/.test(l),
        );
      if (lines.length === 0) {
        done("");
        return;
      }
      if (isWindows) {
        const pid = lines[0].trim().split(/\s+/).pop();
        done(pid ? ` (held by PID ${pid})` : "");
      } else {
        const parts = lines[0].trim().split(/\s+/);
        done(parts.length > 1 ? ` (held by ${parts[0]} PID ${parts[1]})` : "");
      }
    });
  });
}

async function main() {
  // Everything after `--` (or any extra argv) is forwarded to `next start`.
  const forwarded = process.argv.slice(2).filter((a) => a !== "--");
  const port = resolvePort(forwarded);
  const host = resolveHost(forwarded);

  // Forward signals to whichever `next` child is live — the build below as well
  // as the server — so the child is actually reaped on Ctrl-C / CI teardown.
  // This matters most for the build: `next build` rewrites `.next` from scratch,
  // so an orphaned one keeps mutating the directory long after the wrapper that
  // started it is gone, and breaks whatever command runs next.
  const forward = (signal) => () => {
    if (activeChild && !activeChild.killed) activeChild.kill(signal);
    // If we were interrupted mid-autobuild we own the lock; drop it now so the
    // next start builds immediately instead of waiting on our dead PID.
    releaseBuildLock();
  };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));

  // 1. Guarantee there is something to serve. A missing build is BUILT, because
  //    exiting instead is indistinguishable to any client from a hung server —
  //    an unbound port black-holes the SYN, so `/`, `/login` and `/portal/login`
  //    all "time out" and the product reads as unreachable. Concurrency with
  //    another build/e2e/smoke run using `.next` is handled by a lock rather
  //    than by refusing to build. See `ensureProductionBuild`.
  if (!(await ensureProductionBuild())) process.exit(1);

  // 2. Refuse to start onto an occupied port. Without this the run would keep
  //    talking to whatever is already there — usually an orphaned server from a
  //    previous run, serving an older build.
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

  // 3. Hand off to `next start`. The signal handlers installed above now target
  //    the server, so it is reaped on Ctrl-C / CI teardown instead of being
  //    orphaned onto the port.
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

main().catch((err) => {
  console.error("[start] unexpected failure:", err);
  process.exit(1);
});
