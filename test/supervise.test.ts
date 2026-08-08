import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEALTHY_MS,
  DEFAULT_MAX_RESTARTS,
  decideRestart,
  superviseServer,
} from "../scripts/lib/supervise.mjs";

/**
 * Regression guard for server supervision (scripts/lib/supervise.mjs).
 *
 * THE DEFECT THESE PIN
 *
 * `npm start` had thorough guards around STARTUP and none around the rest of the
 * server's life. A single death at any later point ended the wrapper and left the
 * port unbound for the remainder of the run. Reproduced against a good production
 * build: `/` answered 200 in 15ms, the server process was killed the way a crash
 * or an OOM kill kills it, and 20s later the wrapper had exited (code 1) with
 * nothing listening.
 *
 * That is the reported symptom exactly — "the app itself intermittently times out
 * even on '/'". The first part of a crawl gets clean 200s; after one death every
 * URL fails, the static landing page included. Through a forwarded port, container
 * or proxy those failures are TIMEOUTS and not refusals, because an unbound port
 * black-holes the SYN, so one recoverable crash reads as root-level instability
 * blocking all further QA.
 *
 * The policy lives in `decideRestart` as a pure function precisely so it can be
 * pinned here without spawning a real server: these tests drive fake launchers, so
 * the suite stays fast and never touches a port or a `.next`.
 */

/** A launcher that returns the given outcomes in order, recording its calls. */
function scriptedLaunch(
  outcomes: Array<{ served: boolean; code?: number | null; signal?: string | null; upMs?: number }>,
  clock: { now: number },
) {
  const calls: number[] = [];
  return {
    calls,
    launch: async (attempt: number) => {
      calls.push(attempt);
      const o = outcomes[Math.min(attempt - 1, outcomes.length - 1)];
      // Advance the injected clock instead of really waiting, so "this run stayed
      // up for a minute" costs nothing.
      clock.now += o.upMs ?? 0;
      return { served: o.served, code: o.code ?? 0, signal: o.signal ?? null };
    },
  };
}

/** Drive the supervisor with an injected clock and no real sleeping. */
function run(
  outcomes: Parameters<typeof scriptedLaunch>[0],
  opts: Record<string, unknown> = {},
) {
  const clock = { now: 0 };
  const logs: string[] = [];
  const { calls, launch } = scriptedLaunch(outcomes, clock);
  return superviseServer({
    launch,
    log: (m: string) => logs.push(m),
    now: () => clock.now,
    sleep: async () => {},
    ...opts,
  }).then((result) => ({ ...result, calls, logs }));
}

describe("decideRestart — the restart policy", () => {
  it("restarts a server that was serving and then died", () => {
    // The whole point: this is the case that used to end the wrapper and leave
    // the port dark for the rest of the run.
    const d = decideRestart({ served: true, upMs: 5_000, consecutive: 0 });
    expect(d.restart).toBe(true);
    expect(d.consecutive).toBe(1);
  });

  it("does not restart a server that never answered a request", () => {
    // It has proven nothing works, so relaunching is a hot loop — and the caller
    // has a better answer (scripts/start.mjs falls back to `next dev`).
    const d = decideRestart({ served: false, upMs: 800, consecutive: 0 });
    expect(d.restart).toBe(false);
    expect(d.reason).toMatch(/never answered/);
  });

  it("does not restart during a deliberate shutdown, even after a signal", () => {
    // Our own SIGINT/SIGTERM handler kills the child, so the signal it reports
    // must never be mistaken for a crash worth recovering from.
    const d = decideRestart({
      served: true,
      signal: "SIGTERM",
      upMs: 30_000,
      consecutive: 0,
      stopping: true,
    });
    expect(d.restart).toBe(false);
    expect(d.reason).toMatch(/shutting down/);
  });

  it("treats a signal as a crash when we are NOT shutting down", () => {
    // This is how the likeliest cause presents: an OOM kill arrives as SIGKILL
    // from outside the process tree, with no exit code to read.
    const d = decideRestart({ served: true, signal: "SIGKILL", upMs: 9_000, consecutive: 0 });
    expect(d.restart).toBe(true);
    expect(d.reason).toMatch(/SIGKILL/);
  });

  it("gives up once consecutive quick deaths reach the budget", () => {
    // Unbounded restarts would bury the real error under a thousand relaunches,
    // which is its own kind of invisible failure.
    const d = decideRestart({
      served: true,
      upMs: 200,
      consecutive: DEFAULT_MAX_RESTARTS,
    });
    expect(d.restart).toBe(false);
    expect(d.reason).toMatch(/crash loop/);
  });

  it("resets the budget after a run that stayed up, so a rare crash is always recovered", () => {
    // Without the reset, a server crashing once an hour would exhaust its five
    // restarts over five hours and then stay dead forever.
    const d = decideRestart({
      served: true,
      upMs: DEFAULT_HEALTHY_MS + 1,
      consecutive: DEFAULT_MAX_RESTARTS,
    });
    expect(d.restart).toBe(true);
    expect(d.consecutive).toBe(1);
  });

  it("honours a zero budget as 'never restart'", () => {
    // START_SUPERVISE=0 / START_MAX_RESTARTS=0 must restore the old behaviour
    // exactly, for a caller that runs its own process supervisor.
    const d = decideRestart({ served: true, upMs: 5_000, consecutive: 0, maxRestarts: 0 });
    expect(d.restart).toBe(false);
    // Reported as switched off, not as a crash loop — nothing looped.
    expect(d.reason).toMatch(/restarts are disabled/);
  });
});

describe("superviseServer — the loop", () => {
  it("relaunches after a crash and keeps the last outcome", async () => {
    const r = await run([
      { served: true, code: 1, upMs: 5_000 },
      { served: true, code: 7, upMs: DEFAULT_HEALTHY_MS + 1 },
      { served: true, code: 3, upMs: 100 },
    ], { maxRestarts: 1 });

    // Launch 1 crashed → restart. Launch 2 stayed up a minute, so its crash
    // resets the budget → restart. Launch 3 died fast with the budget spent.
    expect(r.calls).toEqual([1, 2, 3]);
    expect(r.restarts).toBe(2);
    expect(r.outcome.code).toBe(3);
    expect(r.reason).toMatch(/crash loop/);
  });

  it("stops immediately without restarting when the server never served", async () => {
    const r = await run([{ served: false, code: 1, upMs: 300 }]);
    expect(r.calls).toEqual([1]);
    expect(r.restarts).toBe(0);
    // The caller's own fallback handles this, so the supervisor stays quiet.
    expect(r.logs).toEqual([]);
  });

  it("stops when a shutdown signal arrives, rather than resurrecting the server", async () => {
    let stopping = false;
    const r = await run(
      [{ served: true, code: 0, upMs: 1_000 }],
      {
        shouldStop: () => stopping,
        // Latch the shutdown the moment the first run ends, as a SIGTERM handler
        // does while the child is being reaped.
        launch: async () => {
          stopping = true;
          return { served: true, code: 0, signal: "SIGTERM" };
        },
      },
    );
    expect(r.restarts).toBe(0);
    expect(r.reason).toMatch(/shutting down/);
  });

  it("does not relaunch when the port cannot be reclaimed", async () => {
    // A relaunch into a port something else has taken would die instantly on
    // EADDRINUSE and spend the whole budget on it; the conflict is worth naming.
    const r = await run([{ served: true, code: 1, upMs: 5_000 }], {
      prepareRestart: async () => false,
    });
    expect(r.calls).toEqual([1]);
    expect(r.reason).toMatch(/port could not be reclaimed/);
  });

  it("says why it is giving up on a server that had been working", async () => {
    // A silently dark port is what made this defect read as an unreachable
    // product for several review rounds; the log has to name it.
    const r = await run(
      Array.from({ length: 3 }, () => ({ served: true, code: 1, upMs: 100 })),
      { maxRestarts: 1 },
    );
    expect(r.logs.join("\n")).toMatch(/Not restarting the server/);
    expect(r.logs.join("\n")).toMatch(/crash loop/);
    expect(r.logs.join("\n")).toMatch(/timed out/);
  });

  it("waits longer between each consecutive restart, but stays bounded", async () => {
    const waits: number[] = [];
    await run(
      Array.from({ length: 6 }, () => ({ served: true, code: 1, upMs: 100 })),
      {
        maxRestarts: 4,
        backoffMs: 1_000,
        maxBackoffMs: 2_500,
        sleep: async (ms: number) => {
          waits.push(ms);
        },
      },
    );
    // Linear, then clamped — a crash loop must still retry promptly enough that a
    // recovery lands inside a caller's navigation budget.
    expect(waits).toEqual([1_000, 2_000, 2_500, 2_500]);
  });
});
