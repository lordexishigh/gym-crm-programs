#!/usr/bin/env node
/**
 * Development server (`npm run dev`).
 *
 * A thin entry point over `scripts/lib/dev-server.mjs`, which explains the one
 * thing this wrapper adds over calling `next dev` directly: the port is not
 * opened until a request has actually been served through it.
 *
 * That matters because `next dev` binds in ~3s and cannot serve `/` for another
 * ~14s (per-route compilation happens on first request). Anything that treats an
 * open port as "ready" — a QA harness, a readiness loop, a person refreshing a
 * browser — spends that gap on a navigation that looks like a hang. Holding the
 * port shut turns "open but unresponsive" into "not open yet", which every
 * readiness loop already knows how to wait for correctly.
 *
 * One thing is preflighted before any of that: PORT ALREADY IN USE. `next dev`
 * fails deep in its own stack with a raw EADDRINUSE, while whatever already
 * holds the port keeps answering — so the run silently talks to another process
 * (commonly an orphan from an earlier run, serving older code) and every result
 * is about the wrong server.
 *
 * Escape hatches: DEV_GATE=0 restores `next dev`'s bind-immediately behaviour,
 * START_DEV_TURBOPACK=0 skips Turbopack. Extra arguments (`npm run dev -- -p
 * 4000`) are honoured for port and hostname.
 *
 * Dependency-free (node: builtins only) so it runs before any install-time
 * assumptions hold.
 */

import process from "node:process";
import {
  describePortHolder,
  portInUse,
  resolveHost,
  resolvePort,
  serveDev,
  stopDev,
} from "./lib/dev-server.mjs";

async function main() {
  const forwarded = process.argv.slice(2).filter((a) => a !== "--");
  const port = resolvePort(forwarded);
  const host = resolveHost(forwarded);

  // Forward signals so the dev server (and the forwarder in front of it) are
  // actually reaped on Ctrl-C / CI teardown. An orphaned dev server matters
  // twice over: it keeps the port, so the next run probes a stale process, and
  // it keeps mutating `.next`, which breaks whatever command runs next.
  const forward = (signal) => () => stopDev(signal);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));

  if (await portInUse(port, host)) {
    const holder = await describePortHolder(port);
    console.error(
      `[dev] Port ${port} is already in use${holder}.\n` +
        "[dev] Refusing to start: the existing process would keep answering on " +
        "this port and may be serving different code.\n" +
        "[dev] Stop it first, or start on a different port: `npm run dev -- -p <port>`.",
    );
    process.exit(1);
  }

  const { code, signal } = await serveDev({ port, host });
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
}

main().catch((err) => {
  console.error("[dev] unexpected failure:", err);
  stopDev();
  process.exit(1);
});
