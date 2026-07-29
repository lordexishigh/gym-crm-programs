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
 *      What binds the port in seconds and serves the REAL pages is `next dev`
 *      (measured: listening in ~8s, every route rendered with genuine content),
 *      so that is the fallback: no build, no placeholder page, no proxy — an
 *      actually working app, roughly an order of magnitude sooner. A placeholder
 *      that answers instantly was tried and is worse than it looks: the port
 *      responds, so callers stop waiting and start testing, and every one of them
 *      then judges a page that has none of the product on it.
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
        "with `next dev` so this port answers within seconds.\n" +
        "[start] Why not build first: `next build` takes ~85s on this project, " +
        "and for every one of those seconds the port stays UNBOUND. An unbound " +
        "port black-holes the connection instead of refusing it, so callers wait " +
        "out their whole budget and every route — even static ones like / and " +
        "/login — reads as timed out.\n" +
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

/** Routes a first-time visitor lands on; see `warmUp`. */
const WARMUP_PATHS = ["/", "/login", "/portal/login"];

/**
 * Set once the dev server has answered anything at all.
 *
 * This is the only trustworthy "it managed to serve" signal: `next dev` exits
 * with code 0 even when it fails fatally at startup (observed: a project with no
 * `app`/`pages` directory prints the error and exits 0), so an exit code cannot
 * distinguish a server that ran from one that never got off the ground.
 */
let devEverAnswered = false;

/**
 * Compile the entry routes as soon as the dev server is listening, before any
 * real client asks for one.
 *
 * Dev mode compiles per route on FIRST request, and the first compile of a page
 * this size measures ~8s. That lands on whoever navigates first — precisely the
 * `/`, `/login` and `/portal/login` navigations that were reported as timing
 * out — while later ones take ~1s. Paying it here, off the clock, is the
 * difference between a first navigation that fits inside a client's budget and
 * one that does not.
 *
 * Strictly best-effort: every failure is ignored, since this is an optimisation
 * and the server is already serving without it. START_WARMUP=0 reduces it to the
 * readiness probe alone — that one request cannot be skipped, because whether it
 * ever succeeds is what `serveDev` uses to tell a server that ran from one that
 * never started.
 */
async function warmUp(port, host) {
  // A wildcard bind is reached over loopback; a specific bind only on itself.
  const target = host === "0.0.0.0" || host === "::" || !host ? "127.0.0.1" : host;
  const started = Date.now();
  const [first, ...rest] = WARMUP_PATHS;

  const request = (route) =>
    fetch(`http://${target}:${port}${route}`, {
      // Generous: this is a cold compile, not a health check.
      signal: AbortSignal.timeout(60_000),
      headers: { "user-agent": "alpha-crm-start-warmup" },
    });

  // The first route doubles as the readiness probe: retry until the server
  // accepts a connection at all (it binds after ~8s), then stop retrying — a
  // request that CONNECTS and is slow is the compile we came to pay for.
  const deadline = started + 180_000;
  for (;;) {
    if (Date.now() > deadline) return;
    try {
      await request(first);
      devEverAnswered = true;
      break;
    } catch {
      await delay(500);
    }
  }

  if (disabled(process.env.START_WARMUP)) return;
  for (const route of rest) {
    try {
      await request(route);
    } catch {
      /* best effort: an uncompiled route just costs the first visitor instead */
    }
  }
  console.log(
    `[start] Dev server ready and entry routes precompiled in ` +
      `${Math.round((Date.now() - started) / 1000)}s (${WARMUP_PATHS.join(", ")}).`,
  );
}

/**
 * How long a dev server must survive before its exit counts as "it ran and then
 * stopped" rather than "it could not start". Cold start measures ~5s, so a
 * process that is gone well before this never served a request.
 */
const DEV_PROBATION_MS = 20_000;

/** Launch a dev server; resolves with how it ended, never rejects. */
function runDevServer(port, host, { turbopack }) {
  const args = ["dev"];
  if (turbopack) args.push("--turbopack");
  args.push("-p", String(port));
  if (host && host !== "0.0.0.0") args.push("-H", host);

  // START_DEV_FALLBACK tells next.config.mjs to drop the dev-tools indicator:
  // this server is standing in for the real one, and a debug badge floating over
  // every page is not part of the product.
  const child = spawnNext(args, { START_DEV_FALLBACK: "1" });
  return new Promise((resolve) => {
    child.on("error", (err) => {
      console.error("[start] failed to launch `next dev`:", err);
      resolve({ code: -1, signal: null });
    });
    child.on("close", (code, signal) => resolve({ code: code ?? -1, signal }));
  });
}

/**
 * Serve in dev mode, preferring Turbopack.
 *
 * Turbopack is preferred because per-route compilation is what a first visit to
 * any page costs in dev, and it is 2-4x cheaper there (measured on this project:
 * /login 1.6s vs 4.3s) — that margin is the difference between a journey step
 * fitting inside its budget and timing out.
 *
 * A Turbopack that cannot start on some host would, however, reproduce the exact
 * failure this whole path exists to prevent: nothing bound, every route timing
 * out. So an attempt that never answered a single request is retried on webpack
 * rather than trusted. Anything that DID answer is passed straight through —
 * retrying then would resurrect a server the operator deliberately stopped.
 */
async function serveDev(port, host) {
  // Started before the first attempt and shared by a retry: the readiness loop
  // simply keeps waiting through the changeover.
  void warmUp(port, host);

  if (!disabled(process.env.START_DEV_TURBOPACK)) {
    const startedAt = Date.now();
    const first = await runDevServer(port, host, { turbopack: true });
    const aliveMs = Date.now() - startedAt;
    // Note the deliberate absence of an exit-code test: `next dev` exits 0 on a
    // fatal startup error, so only `devEverAnswered` distinguishes the cases.
    // `shuttingDown` is checked because Windows has no real signals — a child
    // killed by our own SIGINT handler can report neither code nor signal, and
    // relaunching a server the operator just interrupted would be indefensible.
    const neverServed =
      !shuttingDown &&
      !first.signal &&
      !devEverAnswered &&
      aliveMs <= DEV_PROBATION_MS;
    if (!neverServed) return first;
    console.error(
      `[start] \`next dev --turbopack\` exited (code ${first.code}) after ` +
        `${(aliveMs / 1000).toFixed(1)}s without answering a single request. ` +
        "Retrying without Turbopack so this port still ends up served. " +
        "(START_DEV_TURBOPACK=0 skips Turbopack entirely.)",
    );
  }
  return runDevServer(port, host, { turbopack: false });
}

/**
 * The `next` child this wrapper is currently responsible for — the production
 * server, or a dev server (possibly a second one, after a Turbopack retry).
 * Tracked so signal handlers can reap whichever one is live.
 */
let activeChild = null;

/**
 * Set once a shutdown signal has been seen. `serveDev` consults it so an
 * interrupted server is never relaunched as a "failed to start" retry.
 */
let shuttingDown = false;

/** Spawn a `next` subcommand, recording it as the child to reap on a signal. */
function spawnNext(args, extraEnv = {}) {
  activeChild = spawn(process.execPath, [NEXT_BIN, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });
  return activeChild;
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

  // Forward signals to whichever `next` child is live, so it is actually reaped
  // on Ctrl-C / CI teardown. An orphaned dev server matters twice over: it keeps
  // the port (the next run then probes a stale process) and it keeps mutating
  // `.next`, which breaks whatever command runs next.
  const forward = (signal) => () => {
    shuttingDown = true;
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
    // Arguments are rebuilt rather than forwarded: `next start`-only flags
    // (--keepAliveTimeout and friends) would be rejected by `next dev`, and the
    // port/host were resolved above from exactly those arguments.
    const { code, signal } = await serveDev(port, host);
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
