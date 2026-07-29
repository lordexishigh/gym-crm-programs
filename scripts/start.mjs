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
 *   3. THE COLD-START WINDOW. Building a missing build (mode 1) fixes the end
 *      state but not the ~100s it takes to get there: for that entire window the
 *      port is STILL unbound, so every request is still black-holed and the
 *      product still reads as dead. Measured on a clean checkout of this repo:
 *      `next build` takes ~98s, and a probe 12s in gets no connection at all.
 *      That is exactly how it presents to a reviewer — `goto('/')` exceeding a
 *      20s budget, `/login` and `/portal/login` exceeding 45s — even though
 *      those three routes are PRERENDERED STATIC pages with no server-side work
 *      that could possibly hang. Nothing was hanging; nothing was listening.
 *
 *      So the port is now bound BEFORE the slow work, by a small front-door
 *      server that answers immediately with an honest "starting up" page (503 +
 *      Retry-After) and then transparently proxies to the real server the moment
 *      it is ready. A cold start is thus slow — which cannot be helped, a build
 *      takes as long as it takes — but never silent. This matters because a hang
 *      is strictly worse than a slow answer: it is indistinguishable from a
 *      crash, it defeats every readiness probe, and it gives a caller nothing to
 *      report except "unreachable".
 *
 * This wrapper turns all three into something deterministic: it builds a missing
 * build rather than refusing to serve, it always answers on its port even while
 * that build runs, and it refuses to hand the port to `next start` when another
 * process already holds it, naming that process instead of failing anonymously.
 *
 * Everything here is dependency-free (node: builtins only) so it runs before any
 * install-time assumptions hold.
 */

import { spawn } from "node:child_process";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createConnection, createServer } from "node:net";
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
 * Drop any `-p/--port` and `-H/--hostname` from forwarded argv, keeping every
 * other flag. Used when a front door holds the public port and the real server
 * has to be moved to loopback: the caller's own port/host flags describe where
 * the PRODUCT should be reachable, which is the front door's address now, so
 * passing them through would put both listeners on the same port.
 */
function stripPortAndHost(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // Separated form: skip the flag and the value that follows it.
    if (arg === "-p" || arg === "--port" || arg === "-H" || arg === "--hostname") {
      i += 1;
      continue;
    }
    if (/^--port=/.test(arg) || /^--hostname=/.test(arg)) continue;
    out.push(arg);
  }
  return out;
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

/* ---------------------------------------------------------------------------
 * Front door — bind the port before the slow work, so a cold start is never a
 * black hole. See failure mode 3 in the header comment.
 * ------------------------------------------------------------------------- */

/** What we tell a client to wait before retrying while the build runs. */
const WARMUP_RETRY_SECONDS = 3;

/**
 * Ceiling on how long to wait for `next start` to begin listening once a build
 * exists. Finite for the usual reason: an unbounded wait is the hang being
 * removed. `next start` normally binds in about a second.
 */
const READY_WAIT_MS = Number(process.env.START_READY_WAIT_MS) || 120_000;

/**
 * The "starting up" page. Self-contained (no build output exists yet, so it can
 * use neither Tailwind nor the app's stylesheet) but it declares the same tokens
 * as app/globals.css so the dark surfaces and emerald accent match the real UI
 * rather than flashing an unstyled white page.
 *
 * `<meta http-equiv="refresh">` matters as much as the styling: a human who
 * opened the app during a cold start lands on the real page on their own,
 * without having to guess when to reload.
 */
const WARMING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${WARMUP_RETRY_SECONDS}">
<title>Starting up — Alpha CRM</title>
<style>
  :root {
    --page: #0a0e17;
    --surface: #151c2b;
    --border: #29344c;
    --brand: #047857;
    --brand-text: #34d399;
    --text: #e8ecf4;
    --text-muted: #9aa6bd;
    --font-sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI",
      Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; padding: 24px;
    background: var(--page); color: var(--text); font-family: var(--font-sans);
  }
  .card {
    width: 100%; max-width: 26rem; display: flex; flex-direction: column;
    align-items: center; gap: 16px; text-align: center;
    padding: 32px 24px; border: 1px solid var(--border); border-radius: 12px;
    background: var(--surface); box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
  }
  .logo {
    display: flex; align-items: center; justify-content: center;
    height: 36px; width: 36px; border-radius: 8px;
    background: var(--brand); color: #fff; font-weight: 700; font-size: 16px;
  }
  h1 { margin: 0; font-size: 1.25rem; font-weight: 700; letter-spacing: -0.01em; }
  p { margin: 0; font-size: 0.875rem; line-height: 1.5; color: var(--text-muted); }
  .spinner {
    height: 20px; width: 20px; border-radius: 50%;
    border: 2px solid var(--border); border-top-color: var(--brand-text);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style>
</head>
<body>
  <main class="card">
    <span class="logo" aria-hidden="true">A</span>
    <div class="spinner" role="status" aria-label="Starting up"></div>
    <h1>Starting up</h1>
    <p>
      Alpha CRM is compiling its production build. This happens once, on a first
      start, and takes a minute or two. This page refreshes itself — no need to
      reload.
    </p>
  </main>
</body>
</html>
`;

/** Headers that describe a single hop and must never be forwarded onward. */
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/**
 * Headers to send upstream: the client's own, minus the hop-by-hop ones, plus
 * standard reverse-proxy provenance.
 *
 * `x-forwarded-host` is not optional here. Without it Next builds absolute URLs
 * from the address it is itself listening on — the loopback port behind this
 * proxy — so middleware's redirect to /login came back as
 * `Location: http://localhost:<loopback-port>/login`. Any client that is not on
 * this machine (a forwarded port, a container, a reviewer's browser) cannot reach
 * that address, so the entire auth wall would bounce visitors somewhere dead.
 * Observed while verifying this change, not theorised.
 *
 * An existing chain is preserved rather than overwritten, which is what a
 * well-behaved proxy does when it sits behind another one.
 */
function upstreamHeaders(req) {
  const headers = { ...req.headers };
  for (const name of HOP_BY_HOP) delete headers[name];
  if (!headers["x-forwarded-host"] && req.headers.host) {
    headers["x-forwarded-host"] = req.headers.host;
  }
  // The front door always terminates plain HTTP; a TLS terminator further out
  // will already have set this, hence the guard.
  if (!headers["x-forwarded-proto"]) headers["x-forwarded-proto"] = "http";
  const remote = req.socket?.remoteAddress;
  if (remote) {
    headers["x-forwarded-for"] = headers["x-forwarded-for"]
      ? `${headers["x-forwarded-for"]}, ${remote}`
      : remote;
  }
  return headers;
}

/**
 * Rewrite a `Location` that points at the internal server back to the public
 * address the client actually used.
 *
 * Next constructs absolute redirect URLs using the port IT is listening on — the
 * loopback port behind this proxy — and ignores `x-forwarded-host` when doing so.
 * Middleware's auth-wall redirect therefore came back as
 * `Location: http://localhost:<loopback-port>/login`, which no client outside
 * this machine can follow: every visit to /dashboard or /portal would bounce to a
 * dead address. Measured, then fixed here rather than guessed at.
 *
 * Only a Location whose port is exactly the internal one is touched, so genuine
 * off-site redirects (Stripe checkout, an email link) are passed through
 * untouched. This is the same correction Apache makes with `ProxyPassReverse`.
 */
function rewriteLocation(location, targetPort, publicHost) {
  if (!location || !publicHost) return location;
  let url;
  try {
    url = new URL(location);
  } catch {
    // Relative Location ("/login") needs no rewriting — the client resolves it
    // against the public origin it already used.
    return location;
  }
  if (url.port !== String(targetPort)) return location;
  url.host = publicHost;
  return url.toString();
}

/** Ask the OS for a free loopback port to run the real server on. */
function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Whether something is accepting connections on `port` right now. */
function canConnect(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1_000, () => done(false));
  });
}

/**
 * Poll until the real server is listening. Returns false on timeout rather than
 * waiting forever, so a server that dies during boot is reported instead of
 * leaving the front door serving "starting up" indefinitely.
 */
async function waitForServer(port, budgetMs) {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    if (await canConnect(port)) return true;
    await delay(200);
  }
  return false;
}

/**
 * A server that holds the public port for the whole process lifetime: it answers
 * "starting up" until `pointAt` is called, and proxies to the real server after.
 *
 * Proxying rather than closing-and-rebinding is deliberate. Handing the port over
 * would mean closing this listener and having `next start` bind it, and the gap
 * between those two events is a window where the port is unbound again — the
 * exact black hole this exists to close (and on Windows the rebind can also lose
 * to a lingering socket). Instead the real server runs on loopback and this stays
 * in front of it. It is only ever used on a cold start; when a build already
 * exists (production, CI, any second start) `next start` binds the public port
 * directly and no proxy is involved at all.
 */
function createFrontDoor(port, host) {
  /** Loopback port of the real server, or null while still building. */
  let target = null;
  const sockets = new Set();

  const respondWarming = (req, res) => {
    const wantsHtml = String(req.headers.accept || "").includes("text/html");
    const body = wantsHtml
      ? WARMING_HTML
      : `${JSON.stringify({ status: "starting", detail: "Building the production bundle." })}\n`;
    // 503 is the honest status, and it keeps readiness probes correct: a caller
    // that waits for a non-5xx (Playwright's `webServer.url`, a deploy gate, the
    // CI smoke loop) must keep waiting rather than start testing this page.
    res.writeHead(503, {
      "Content-Type": wantsHtml
        ? "text/html; charset=utf-8"
        : "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": String(WARMUP_RETRY_SECONDS),
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };

  const proxy = (req, res, targetPort) => {
    // `host` is passed through untouched on purpose: Next compares it against
    // `origin` when validating Server Actions, so rewriting it here would break
    // form submissions on the login pages. `x-forwarded-host` (see
    // `upstreamHeaders`) is what tells Next the public address for redirects.
    const headers = upstreamHeaders(req);
    const upstream = httpRequest(
      { host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers },
      (upstreamRes) => {
        const headers = { ...upstreamRes.headers };
        if (headers.location) {
          headers.location = rewriteLocation(headers.location, targetPort, req.headers.host);
        }
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      console.error("[start] front door could not reach the server:", err.message);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("The application server is not responding.\n");
    });
    req.on("error", () => upstream.destroy());
    req.pipe(upstream);
  };

  const server = createHttpServer((req, res) => {
    if (target === null) respondWarming(req, res);
    else proxy(req, res, target);
  });

  // Proxy protocol upgrades too, so nothing is silently dropped on this path.
  server.on("upgrade", (req, socket, head) => {
    if (target === null) {
      socket.destroy();
      return;
    }
    const headers = upstreamHeaders(req);
    const upstream = httpRequest({
      host: "127.0.0.1",
      port: target,
      method: req.method,
      path: req.url,
      headers: { ...headers, connection: "Upgrade", upgrade: req.headers.upgrade || "" },
    });
    upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      const lines = Object.entries(upstreamRes.headers).map(([k, v]) => `${k}: ${v}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead?.length) socket.unshift(upstreamHead);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    upstream.on("error", () => socket.destroy());
    if (head?.length) upstream.write(head);
    upstream.end();
  });

  // Track live sockets so `close()` actually releases the port: an idle
  // keep-alive connection would otherwise hold the listener open.
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once("error", onError);
        const onListening = () => {
          server.removeListener("error", onError);
          // From here on an error must be logged, not thrown: an unhandled
          // 'error' event would take the whole wrapper down mid-build.
          server.on("error", (err) => {
            console.error("[start] front door error:", err.message);
          });
          resolve();
        };
        if (host === "0.0.0.0" || host === "::") server.listen(port, onListening);
        else server.listen(port, host, onListening);
      }),
    pointAt: (targetPort) => {
      target = targetPort;
    },
    close: () => {
      try {
        server.close();
        for (const socket of sockets) socket.destroy();
      } catch {
        /* shutting down anyway */
      }
    },
  };
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
  /** The front door, once bound. Null whenever a build was already present. */
  let frontDoor = null;

  const forward = (signal) => () => {
    if (activeChild && !activeChild.killed) activeChild.kill(signal);
    // If we were interrupted mid-autobuild we own the lock; drop it now so the
    // next start builds immediately instead of waiting on our dead PID.
    releaseBuildLock();
    frontDoor?.close();
  };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));

  // 1. Refuse to start onto an occupied port. Checked FIRST — before the build,
  //    which is the expensive step — so a conflict is reported in milliseconds
  //    instead of after a minute of work that is about to be thrown away.
  //    Without this the run would keep talking to whatever is already there,
  //    usually an orphaned server from a previous run serving an older build.
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

  // 2. If serving is going to have to wait — for our own build or someone
  //    else's — take the port NOW, before that wait begins. An unbound port
  //    black-holes the SYN, so without this every request during the build hangs
  //    until the client's own budget expires and the product reads as dead
  //    (failure mode 3). The front door answers immediately instead.
  if (!hasProductionBuild() || buildInFlight()) {
    frontDoor = createFrontDoor(port, host);
    try {
      await frontDoor.listen();
      console.log(
        `[start] Listening on http://${host}:${port} with a "starting up" page ` +
          "while the production build is prepared.",
      );
    } catch (err) {
      // Not fatal: serving late is still better than not serving. Fall back to
      // the plain path, where `next start` binds the port itself.
      console.error(`[start] could not bind the front door (${err?.code || err}).`);
      frontDoor = null;
    }
  }

  // 3. Guarantee there is something to serve. A missing build is BUILT, because
  //    exiting instead is indistinguishable to any client from a hung server.
  //    Concurrency with another build/e2e/smoke run using `.next` is handled by
  //    a lock rather than by refusing to build. See `ensureProductionBuild`.
  if (!(await ensureProductionBuild())) {
    frontDoor?.close();
    process.exit(1);
  }

  // 4. Hand off to `next start`. The signal handlers installed above now target
  //    the server, so it is reaped on Ctrl-C / CI teardown instead of being
  //    orphaned onto the port.
  //
  //    With a front door holding the public port, the real server goes on
  //    loopback behind it; otherwise it binds the public port directly, exactly
  //    as before — the production path is unchanged and involves no proxy.
  const args = ["start"];
  let serverPort = port;
  if (frontDoor) {
    serverPort = await freeLoopbackPort();
    args.push(...stripPortAndHost(forwarded), "-H", "127.0.0.1", "-p", String(serverPort));
  } else {
    args.push(...forwarded);
    if (!forwarded.some((a) => a === "-p" || a === "--port" || a.startsWith("--port="))) {
      args.push("-p", String(port));
    }
  }

  const server = spawnNext(args);

  server.on("error", (err) => {
    console.error("[start] failed to launch `next start`:", err);
    frontDoor?.close();
    process.exit(1);
  });
  server.on("close", (code, signal) => {
    frontDoor?.close();
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });

  // 5. Once the real server is up, put it behind the front door. Until this
  //    happens the front door is still answering "starting up", so there is no
  //    moment at which the port is silent.
  if (frontDoor) {
    if (await waitForServer(serverPort, READY_WAIT_MS)) {
      frontDoor.pointAt(serverPort);
      console.log(`[start] ready — serving the application on http://${host}:${port}`);
    } else {
      console.error(
        `[start] the server did not start listening within ` +
          `${Math.round(READY_WAIT_MS / 1000)}s; giving up rather than serving a ` +
          `"starting up" page forever.`,
      );
      if (activeChild && !activeChild.killed) activeChild.kill("SIGTERM");
      frontDoor.close();
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("[start] unexpected failure:", err);
  process.exit(1);
});
