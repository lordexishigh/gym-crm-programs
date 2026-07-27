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
 *      This is reported, not repaired: building from `npm start` is opt-in
 *      (START_AUTOBUILD=1), because `next build` DELETES `.next` before it
 *      writes, so an implicit build clobbers whatever build, smoke test or e2e
 *      run is already using that directory. See step 1 in `main`.
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
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const NEXT_BIN = require.resolve("next/dist/bin/next");

/** Truthy-on check for the opt-in flags. Unset means off. */
function enabled(value) {
  return value === "1" || value === "true";
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
  };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));

  // 1. Require a usable production build; report a missing one rather than
  //    quietly building it. `next build` DELETES `.next` before writing, so a
  //    build started implicitly here clobbers the output of any build, smoke
  //    test or e2e run already using that directory. The victim then fails
  //    somewhere unrelated to the cause — a prerender whose
  //    `.next/server/pages-manifest.json` vanished mid-build — which is far
  //    harder to diagnose than the missing build an implicit build would have
  //    papered over. `npm start` is also the e2e/CI webServer command, where a
  //    surprise multi-minute build just exhausts the harness's start timeout and
  //    gets killed. Opt in with START_AUTOBUILD=1 when nothing else is using
  //    `.next` (a fresh clone, a single-purpose container).
  if (!hasProductionBuild()) {
    if (!enabled(process.env.START_AUTOBUILD)) {
      console.error(
        "[start] No production build found (.next/BUILD_ID is missing); " +
          "`next start` would exit and nothing would ever bind this port.\n" +
          "[start] Run `npm run build` first, then `npm start`.\n" +
          "[start] (START_AUTOBUILD=1 builds from `npm start` instead — only do " +
          "that when no other build or server is using .next.)",
      );
      process.exit(1);
    }
    console.log(
      "[start] No production build found (.next/BUILD_ID is missing) and " +
        "START_AUTOBUILD=1 — running `next build` first so the server has " +
        "something to serve.",
    );
    const code = await runNext(["build"]);
    if (code !== 0) {
      console.error(`[start] build failed with exit code ${code}; not starting.`);
      process.exit(code > 0 ? code : 1);
    }
    if (!hasProductionBuild()) {
      console.error("[start] build reported success but .next/BUILD_ID is still missing.");
      process.exit(1);
    }
  }

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
