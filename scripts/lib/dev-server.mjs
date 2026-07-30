/**
 * Serving this app with `next dev`, with a READINESS GATE.
 *
 * Shared by both entry points that can end up running a dev server:
 *   - `npm run dev`  (scripts/dev.mjs)
 *   - `npm start` on a checkout with no production build (scripts/start.mjs)
 *
 * WHY A GATE EXISTS
 *
 * `next dev` binds its port long before it can serve anything. Measured on this
 * project, from a cold `.next`:
 *
 *     port accepts connections   3.3s        <- every readiness check passes here
 *     "✓ Ready in 5.1s"          5.1s        <- and here
 *     GET / returns 200         19.3s        <- but the product is only usable here
 *
 * The gap is per-route compilation, which dev does on FIRST REQUEST: `/` alone
 * costs ~10s to compile (webpack 9.9s, Turbopack 8.2s — the first route pays for
 * the whole shared framework graph either way).
 *
 * So for ~14 seconds this app accepts connections and answers none of them. Any
 * caller that treats "the port is open" or "Ready" as "ready for QA" — every
 * conventional readiness loop does — starts navigating inside that window, and
 * its first navigation waits out the compile. Against a 20s budget that is a
 * coin flip: locally `goto('/')` lands at ~16-17s, and on a slower or
 * colder-cached host it does not land at all. That is exactly the reported
 * failure — "journey FAILS at step 1 (goto '/'): Timeout 20000ms exceeded" —
 * and why it reads as a hung server rather than a slow one.
 *
 * Compiling faster is not the fix; the floor is the first compile. Warming in
 * the background is not the fix either, because a client arriving at t=0 just
 * joins the compile it was meant to skip. The fix is to stop lying about
 * readiness: DO NOT OPEN THE PUBLIC PORT UNTIL A REAL REQUEST HAS BEEN SERVED.
 *
 * HOW
 *
 * `next dev` is given an internal port on the loopback interface. Its entry
 * routes are compiled by requesting them there, with no client watching. Only
 * once EVERY one of them has genuinely answered does a byte-for-byte TCP
 * forwarder open the PUBLIC port. Time to a servable port is unchanged (the
 * compile is paid either way); what changes is that the port stays SHUT for that
 * window instead of open and unresponsive, so a readiness loop keeps polling and
 * then meets a server that answers in ~100ms instead of being waved through into
 * a 15s navigation.
 *
 * "Every entry route" rather than "`/`" is load-bearing — see `warmUp`. Gating on
 * `/` alone leaves `/login` and `/portal/login` compiling behind an open port,
 * which recreates this same defect for exactly the pages a caller visits second.
 *
 * The forwarder never interprets HTTP — it pipes bytes — so streaming RSC
 * payloads, Server Actions and the HMR websocket upgrade pass through untouched.
 * It is not a placeholder page and never serves content of its own: a stand-in
 * that answers instantly is worse than a shut port, because callers stop waiting
 * and start judging a page with none of the product on it.
 *
 * Bounded twice over, so this can never be worse than binding directly. If
 * nothing has answered within DEV_GATE_MAX_MS the port opens anyway; and once
 * SOMETHING has answered, the remaining routes get only DEV_GATE_SECONDARY_MS
 * before the port opens without them — waiting for more routes must never let one
 * silent route hide a landing page that works. Either way the app's own response,
 * error page included, becomes visible and the warning names what was never
 * confirmed. DEV_GATE=0 opts out entirely and restores `next dev`'s own
 * bind-immediately behaviour; DEV_WARMUP=0 narrows the gate back to `/`.
 *
 * Everything here is dependency-free (node: builtins only) so it runs before any
 * install-time assumptions hold.
 */

import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const NEXT_BIN = require.resolve("next/dist/bin/next");

/**
 * Routes a first-time visitor (or a QA journey) lands on, and therefore the
 * routes the readiness gate waits for — ALL of them, not just the first. `/`
 * leads because it is the primary entry point; the two login pages are the only
 * way into the product, so a port that opens before they can be served is not
 * usable in any sense a caller cares about.
 */
export const ENTRY_PATHS = ["/", "/login", "/portal/login"];

/**
 * Ceiling on waiting for the entry routes before opening the port regardless.
 * Read per call, not at module load, so a caller (or a test) that sets the
 * variable after this module is imported still gets the budget it asked for.
 */
const gateMaxMs = () => Number(process.env.DEV_GATE_MAX_MS) || 120_000;

/** Per-request ceiling while warming. Generous: this is a cold compile. */
const WARM_REQUEST_MS = 90_000;

/**
 * Ceiling on how long the entry routes AFTER the first may hold the port shut.
 *
 * Because the gate waits for every entry route (see `warmUp`), a single route
 * that connects but never answers could otherwise keep the port closed for the
 * whole gate budget — hiding a landing page that demonstrably works behind an
 * unreachable host, which is the cure becoming the disease. Once ANY route has
 * answered the shared module graph is warm, so a route still silent after this
 * grace period is far more likely broken than slow, and the useful thing to do is
 * open the port and name it. Tunable via DEV_GATE_SECONDARY_MS; read per call for
 * the same reason as `gateMaxMs`.
 */
const secondaryGraceMs = () => Number(process.env.DEV_GATE_SECONDARY_MS) || 45_000;

/**
 * How long a dev server must survive before its exit counts as "it ran and then
 * stopped" rather than "it could not start". Cold start measures ~5s, so a
 * process gone well before this never served a request.
 */
const DEV_PROBATION_MS = 20_000;

/** Explicit opt-OUT check. Only an explicit falsy value disables a default-on flag. */
export function disabled(value) {
  return value === "0" || value === "false";
}

/** Resolve after `ms`, without pulling in a timers/promises import. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the port the same way `next` does, so a preflight check and the server
 * can never disagree: an explicit `-p/--port` flag wins, then `PORT`, then
 * Next's own default of 3000.
 */
export function resolvePort(argv) {
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

/** The hostname `next` will bind, mirroring its own flag handling. */
export function resolveHost(argv) {
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

/** Whether a host string means "every interface". */
function isWildcard(host) {
  return !host || host === "0.0.0.0" || host === "::";
}

/** How to describe `host` in a URL. */
function displayHost(host) {
  return isWildcard(host) ? "localhost" : host;
}

/**
 * Probe whether `port` can actually be bound, rather than assuming it is free.
 * Binds the same host the server will use so the answer reflects the real
 * conflict (a server on 0.0.0.0 does conflict with one on 127.0.0.1).
 */
export function portInUse(port, host) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (err) => {
      probe.close();
      resolve(Boolean(err) && err.code === "EADDRINUSE");
    });
    probe.once("listening", () => probe.close(() => resolve(false)));
    if (isWildcard(host)) probe.listen(port);
    else probe.listen(port, host);
  });
}

/**
 * Best-effort identification of whoever holds the port, so the operator gets a
 * name and a PID instead of just "in use". Platform-specific and entirely
 * optional — any failure degrades to no extra detail.
 */
export function describePortHolder(port) {
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

/** Ask the OS for a free loopback port to hide the dev server behind. */
function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Open the public port as a byte-for-byte forwarder to the dev server.
 *
 * Deliberately a raw TCP pipe rather than an HTTP proxy: nothing here parses,
 * buffers or rewrites a request, so RSC streaming, Server Actions and the HMR
 * websocket upgrade behave exactly as they would on a direct bind.
 *
 * Exported for tests, which drive it against a stub upstream.
 */
export function openGate({ port, host, upstreamPort }) {
  return new Promise((resolve, reject) => {
    const server = createServer((client) => {
      const upstream = connect({ port: upstreamPort, host: "127.0.0.1" });
      // Either side dying must tear down the other, or a socket leaks per request.
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    });
    server.once("error", reject);
    const listening = () => {
      // Replace the one-shot rejecter: an error AFTER listening must not reject
      // an already-resolved promise (an unhandled rejection) nor crash the
      // process — a single bad client socket is not a reason to stop serving.
      server.removeAllListeners("error");
      server.on("error", (err) => console.error("[dev] forwarder error:", err));
      resolve(server);
    };
    if (isWildcard(host)) server.listen(port, listening);
    else server.listen(port, host, listening);
  });
}

/**
 * The `next dev` child this module is responsible for, and the forwarder in
 * front of it. Tracked so a signal handler can reap both.
 */
let activeChild = null;
let activeGate = null;

/**
 * Set once a shutdown signal has been seen, so an interrupted server is never
 * relaunched as a "failed to start" retry and warming stops promptly.
 */
let shuttingDown = false;

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
 * The forwarder currently in front of the dev server, if the gate has opened one.
 * Exported for tests, which drive `warmUp` directly and need to close the port it
 * opened — `stopDev` would also latch `shuttingDown`, which is correct for a real
 * shutdown but would make every later `warmUp` in the same process return at once.
 */
export function activeForwarder() {
  return activeGate;
}

/** Tear down the dev server and its forwarder. Safe to call unconditionally. */
export function stopDev(signal = "SIGTERM") {
  shuttingDown = true;
  if (activeGate) {
    activeGate.close();
    activeGate = null;
  }
  if (activeChild && !activeChild.killed) activeChild.kill(signal);
}

/**
 * Launch `next dev` bound to `host:port`; resolves with how it ended, never
 * rejects. When gated, `host` is loopback — an ungated dev server must not be
 * reachable from outside this machine, since reaching it would bypass the gate.
 */
function runDevServer({ port, host, turbopack, env }) {
  const args = ["dev", ...(turbopack ? ["--turbopack"] : []), "-p", String(port)];
  if (!isWildcard(host)) args.push("-H", host);

  activeChild = spawn(process.execPath, [NEXT_BIN, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  const child = activeChild;

  return new Promise((resolve) => {
    child.on("error", (err) => {
      console.error("[dev] failed to launch `next dev`:", err);
      resolve({ code: -1, signal: null });
    });
    child.on("close", (code, signal) => resolve({ code: code ?? -1, signal }));
  });
}

/**
 * Compile the entry routes by requesting them on `upstreamPort`, and — when
 * gating — open the public port once EVERY entry route has genuinely been
 * served.
 *
 * Runs even when ungated, because the first request is also the only reliable
 * "this server actually served something" signal (see `devEverAnswered`), which
 * is what decides whether a dead Turbopack attempt gets retried on webpack.
 *
 * WHY THE GATE COVERS EVERY ENTRY ROUTE AND NOT JUST `/`
 *
 * An earlier revision opened the port the moment `/` answered and left `/login`
 * and `/portal/login` to compile BEHIND the now-open port, on the reasoning that
 * `/` is what a caller navigates to first and the others only cost "an extra
 * ~2s". That reproduces the exact trap this gate exists to close, one level
 * down. An open port is universally read as "ready for QA", so the caller starts
 * navigating immediately and its first request to `/login` is the one that pays
 * that route's cold compile — under contention (parallel journeys, a loaded CI
 * host, or the webpack fallback instead of Turbopack) far more than 2s.
 *
 * The resulting failure is worse than a plain slow start because of how it
 * reads: `/` loads fine — it was compiled before the port opened — while both
 * login routes time out. That is not diagnosed as "the dev server was announced
 * ready too early"; it is diagnosed as "the landing page is the only reachable
 * page and every feature is behind a broken auth wall", which is what an
 * automated review of this project reported.
 *
 * Waiting for all three costs almost nothing, because they are warmed
 * CONCURRENTLY and the expensive part — the shared framework/Tailwind module
 * graph — is compiled once for whichever route reaches it first. Measured on
 * this project from a cold `.next`: ~22s to gate on `/` alone, against 18.5s to
 * gate on all three — warming them together is if anything FASTER than warming
 * `/` and then the rest in series. So the port opens at substantially the same
 * moment it did before, and "open" now means every entry route is servable
 * rather than just the landing page.
 *
 * DEV_WARMUP=0 narrows the gate back to `/` for a caller that only wants the
 * landing page and wants the port as early as possible.
 *
 * Exported for tests, which drive it against a stub upstream that answers `/`
 * immediately and `/login` slowly — the shape that regressed.
 */
export async function warmUp({ port, host, upstreamHost, upstreamPort, gated }) {
  const started = Date.now();
  // When gated the upstream is loopback by construction. When not, `next dev`
  // holds the caller's own host: a wildcard bind is reachable over loopback, but
  // a specific bind answers only on that address — probing 127.0.0.1 there would
  // never connect, and the retry loop would wait out the whole budget.
  const target = isWildcard(upstreamHost) ? "127.0.0.1" : upstreamHost;
  const request = (route) =>
    fetch(`http://${target}:${upstreamPort}${route}`, {
      signal: AbortSignal.timeout(WARM_REQUEST_MS),
      headers: { "user-agent": "alpha-crm-dev-warmup" },
    });

  const gateBudget = gateMaxMs();
  const graceBudget = secondaryGraceMs();
  const deadline = started + gateBudget;
  const required = disabled(process.env.DEV_WARMUP) ? ENTRY_PATHS.slice(0, 1) : ENTRY_PATHS;

  /** When the first entry route answered — the point the shared graph went warm. */
  let firstAnsweredAt = null;

  /**
   * The deadline a route may hold the gate to. The leading route gets the full
   * budget (nothing is warm yet, and it is the one worth waiting for); the rest
   * get a bounded grace period once something has answered. See
   * `secondaryGraceMs`.
   */
  const limitFor = (leading) =>
    leading || firstAnsweredAt === null
      ? deadline
      : Math.min(deadline, firstAnsweredAt + graceBudget);

  /** How often an in-flight warm request re-checks the limit it is running under. */
  const POLL_MS = 250;

  /**
   * Serve `route`. Retries only while the server refuses the CONNECTION (its
   * ~3-5s startup); a request that connects and is slow is the compile being paid
   * for, so it is awaited rather than retried. Resolves true when the route
   * actually answered, false once its share of the gate budget has run out.
   *
   * The wait is polled in short slices rather than awaited outright because the
   * limit TIGHTENS mid-flight: all routes start together, so `firstAnsweredAt`
   * (and with it the secondary grace deadline) is still unset when a secondary
   * route issues its first request. Awaiting the limit computed at that moment
   * would commit the route to the full gate budget and defeat the grace period.
   * Polling notices the tightened deadline without abandoning and re-issuing the
   * request, which for a compiling route would just restart the clock.
   */
  const serve = async (route, leading) => {
    for (;;) {
      if (shuttingDown) return false;
      if (Date.now() >= limitFor(leading)) return false;

      // The detached catch matters: an attempt this function walks away from is
      // still compiling the route (useful), but its later rejection would
      // otherwise surface as an unhandled rejection and take the process down.
      const attempt = request(route);
      attempt.catch(() => {});

      let settled = false;
      while (!settled) {
        const outcome = await Promise.race([
          attempt.then(
            () => "answered",
            () => "failed",
          ),
          delay(POLL_MS).then(() => "pending"),
        ]);
        if (outcome === "answered") {
          if (firstAnsweredAt === null) firstAnsweredAt = Date.now();
          // Any one route answering proves the server got off the ground, which
          // is all `devEverAnswered` claims (see the Turbopack retry in
          // `serveDev`).
          devEverAnswered = true;
          return true;
        }
        if (outcome === "failed") {
          // Refused connection (or an aborted WARM_REQUEST_MS): the server is
          // still starting. Back off, then issue a fresh request.
          settled = true;
          await delay(POLL_MS);
          continue;
        }
        // Still in flight. Give up only if this route's limit has passed.
        if (shuttingDown) return false;
        if (Date.now() >= limitFor(leading)) return false;
      }
    }
  };

  // Concurrent, not sequential: the shared module graph is then compiled once
  // rather than once per route in series, which is what keeps gating on all
  // three as fast as gating on `/`.
  const answered = await Promise.all(required.map((route, i) => serve(route, i === 0)));
  if (shuttingDown) return;

  const unanswered = required.filter((_, i) => !answered[i]);
  if (unanswered.length && gated) {
    console.warn(
      `[dev] ${unanswered.map((r) => `\`${r}\``).join(", ")} did not answer within ` +
        `${Math.round(gateBudget / 1000)}s` +
        // Only mention the tighter secondary bound when it is the one that fired,
        // i.e. when something else did answer first.
        (unanswered.length < required.length
          ? ` (or within ${Math.round(graceBudget / 1000)}s of the first route that did)`
          : "") +
        "; opening the port anyway so the app's own response — including an error " +
        "page — is visible rather than hidden behind a shut port.",
    );
  }

  if (gated) {
    try {
      activeGate = await openGate({ port, host, upstreamPort });
    } catch (err) {
      // The public port was free at preflight and has been taken since. Failing
      // loudly beats forwarding nowhere.
      console.error(
        `[dev] Could not open port ${port} (${err?.code || err}): something took it ` +
          "after startup began. Stop that process and try again.",
      );
      stopDev();
      return;
    }
    console.log(
      `[dev] Listening on http://${displayHost(host)}:${port} after ` +
        `${Math.round((Date.now() - started) / 1000)}s — ` +
        (unanswered.length
          ? `WITHOUT a confirmed response on ${unanswered.join(", ")} (see the warning above).`
          : `every entry route (${required.join(", ")}) is compiled and served, so the ` +
            "port opens only now that it can actually answer."),
    );
  }

  if (unanswered.length) return;
  console.log(
    `[dev] Ready for QA in ${Math.round((Date.now() - started) / 1000)}s — entry routes ` +
      `precompiled (${required.join(", ")}).`,
  );
}

/**
 * Serve this checkout with `next dev` on `port`, gated on real readiness.
 *
 * Turbopack is preferred because per-route compilation is what a first visit to
 * any page costs in dev, and it is cheaper there (measured on this project:
 * /login 1.6s vs 4.3s, /portal/login 1.0s vs 1.2s). A Turbopack that cannot
 * start on some host would, however, reproduce the very failure this path exists
 * to prevent — nothing serving — so an attempt that never answered a single
 * request is retried on webpack rather than trusted. Anything that DID answer is
 * passed straight through: retrying then would resurrect a server the operator
 * deliberately stopped.
 *
 * Resolves with how the dev server ended: `{ code, signal }`.
 */
export async function serveDev({ port, host, env = {} }) {
  // DEV_GATE=0 restores a plain direct bind (port open immediately, first
  // navigation pays the compile) for callers who want `next dev`'s own shape.
  let gated = !disabled(process.env.DEV_GATE);
  let upstreamPort = port;
  let upstreamHost = host;

  if (gated) {
    try {
      upstreamPort = await reserveLoopbackPort();
      upstreamHost = "127.0.0.1";
    } catch (err) {
      console.error(
        `[dev] Could not reserve an internal port (${err?.code || err}); binding ` +
          "directly instead, so the first navigation pays the compile.",
      );
      gated = false;
      upstreamPort = port;
    }
  }

  // Started before the first attempt and shared by a Turbopack retry: the
  // readiness loop simply keeps waiting through the changeover, which is why the
  // internal port is reserved once rather than per attempt.
  void warmUp({ port, host, upstreamHost, upstreamPort, gated });

  const attempt = (turbopack) =>
    runDevServer({ port: upstreamPort, host: upstreamHost, turbopack, env });

  if (!disabled(process.env.START_DEV_TURBOPACK)) {
    const startedAt = Date.now();
    const first = await attempt(true);
    const aliveMs = Date.now() - startedAt;
    // Note the deliberate absence of an exit-code test: `next dev` exits 0 on a
    // fatal startup error, so only `devEverAnswered` distinguishes the cases.
    // `shuttingDown` is checked because Windows has no real signals — a child
    // killed by our own SIGINT handler can report neither code nor signal, and
    // relaunching a server the operator just interrupted would be indefensible.
    const neverServed =
      !shuttingDown && !first.signal && !devEverAnswered && aliveMs <= DEV_PROBATION_MS;
    if (!neverServed) {
      stopDev();
      return first;
    }
    console.error(
      `[dev] \`next dev --turbopack\` exited (code ${first.code}) after ` +
        `${(aliveMs / 1000).toFixed(1)}s without answering a single request. ` +
        "Retrying without Turbopack so this port still ends up served. " +
        "(START_DEV_TURBOPACK=0 skips Turbopack entirely.)",
    );
  }
  const result = await attempt(false);
  stopDev();
  return result;
}
