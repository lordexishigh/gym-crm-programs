/**
 * Keeping the server RUNNING, not merely getting it started.
 *
 * WHY THIS EXISTS
 *
 * scripts/start.mjs already goes to considerable lengths to guarantee that
 * something ends up bound to the port: it refuses an occupied port, validates the
 * whole `.next` artifact set, and watches `next start` until it has actually
 * answered a request before trusting it. Every one of those guards covers
 * STARTUP. None of them covered the rest of the process's life, and that gap is
 * the one an automated review kept reporting as "the app itself intermittently
 * times out even on '/'".
 *
 * Reproduced on this project, against a good production build:
 *
 *     ready: / -> 200 (15ms)
 *     <the server process is killed, as a crash or an OOM kill would>
 *     t+1000ms:  / -> ERR   wrapper exited? {"code":1,"sig":null}
 *     t+20000ms: / -> ERR   wrapper exited? {"code":1,"sig":null}
 *
 * A SINGLE death, at any point, ended the wrapper and left the port unbound for
 * the remainder of the run. That is exactly the shape of the report: the crawl
 * gets clean 200s from `/`, `/login` and `/portal/login`, then something takes the
 * server down and from that moment every URL — including the static landing page
 * that demonstrably worked seconds earlier — fails. Locally the failure is a
 * prompt connection refusal, which looks nothing like the reported symptom; but a
 * caller reaching the host through a forwarded port, container or proxy gets NO
 * refusal, because an unbound port black-holes the SYN, so each request instead
 * hangs until the caller's own budget expires. Hence "times out", hence
 * "intermittently" (the first half of the crawl really did work), and hence a
 * verdict of root-level instability blocking all further QA rather than one
 * recoverable crash.
 *
 * Note what this does NOT claim: it does not identify what kills the server. A
 * crawl of every route on this project (entry, DB-backed, auth-guarded, 404) runs
 * clean and the process survives, so there is no known in-app crash to fix. The
 * defect being fixed here is that ANY death — an OOM kill on a small container, a
 * platform recycling the process, a bug not yet found — was permanent. A server
 * that comes back within a second turns that into one failed request instead of
 * one failed QA run.
 *
 * THE POLICY, and why it is not simply "always restart"
 *
 *   - A server that never answered a request is NOT restarted. It has proven
 *     nothing works, so relaunching it is a hot loop; the caller has a better
 *     answer for that case (scripts/start.mjs falls back to `next dev`).
 *   - A deliberate shutdown is not a crash. `shouldStop` is authoritative, so
 *     Ctrl-C and CI teardown end the loop instead of resurrecting a server the
 *     operator just stopped.
 *   - Signals ARE treated as crashes when we are not shutting down, because that
 *     is precisely how the most likely cause presents: an OOM kill arrives as
 *     SIGKILL from outside the process tree.
 *   - Restarts are BOUNDED, and the budget resets after a run that stayed up.
 *     Without the reset, a server crashing once an hour would exhaust five
 *     restarts over five hours and then stay dead; without the bound, a server
 *     that dies immediately every time would spin forever. Consecutive quick
 *     deaths are a crash loop and are reported as one — restarting a thousand
 *     times would bury the actual error in the log, which is its own kind of
 *     invisible failure.
 *
 * `decideRestart` holds all of that as a pure function so the policy — rather than
 * a real server — is what the tests exercise. Everything here is dependency-free
 * (node: builtins only, and in fact none) so it runs before any install-time
 * assumptions hold.
 */

/** Restarts allowed before consecutive quick deaths are called a crash loop. */
export const DEFAULT_MAX_RESTARTS = 5;

/**
 * How long a run must last to count as healthy, which resets the restart budget.
 * Well above the measured ~1.4s startup: a process that survives a minute of
 * serving was not failing to start, it failed later and for another reason.
 */
export const DEFAULT_HEALTHY_MS = 60_000;

/** Base delay before a relaunch, multiplied by the consecutive-restart count. */
export const DEFAULT_BACKOFF_MS = 500;

/** Ceiling on that backoff, so a crash loop still retries promptly enough to matter. */
export const DEFAULT_MAX_BACKOFF_MS = 5_000;

/**
 * Whether a finished run should be relaunched, and why either way.
 *
 * Pure and total: every branch returns a `reason` the caller logs verbatim, so a
 * supervisor that gives up always says which rule made it give up.
 *
 * @param {{
 *   served: boolean,
 *   signal?: string | null,
 *   code?: number | null,
 *   upMs: number,
 *   consecutive: number,
 *   stopping?: boolean,
 *   maxRestarts?: number,
 *   healthyAfterMs?: number,
 * }} run
 * @returns {{ restart: boolean, reason: string, consecutive: number }}
 *   `consecutive` is the count to carry forward: reset to 0 by a healthy run,
 *   incremented by a quick death.
 */
export function decideRestart({
  served,
  signal = null,
  upMs,
  consecutive,
  stopping = false,
  maxRestarts = DEFAULT_MAX_RESTARTS,
  healthyAfterMs = DEFAULT_HEALTHY_MS,
}) {
  // Checked first, and before `signal`, because our own shutdown handler kills the
  // child: the signal it reports must not be mistaken for a crash.
  if (stopping) {
    return { restart: false, reason: "shutting down", consecutive };
  }

  // Nothing to keep alive. The caller owns this case — it has a fallback that a
  // relaunch of the same broken thing would only delay.
  if (!served) {
    return { restart: false, reason: "it never answered a request", consecutive };
  }

  // Supervision switched off entirely (START_SUPERVISE=0 / START_MAX_RESTARTS=0),
  // for a caller that runs its own process supervisor and wants this one to exit
  // with the server. Reported distinctly from a crash loop: nothing looped.
  if (maxRestarts <= 0) {
    return {
      restart: false,
      reason: "restarts are disabled (START_SUPERVISE=0 / START_MAX_RESTARTS=0)",
      consecutive,
    };
  }

  // A run that stayed up was not failing to start, so it earns a fresh budget.
  const healthy = upMs >= healthyAfterMs;
  const priorConsecutive = healthy ? 0 : consecutive;

  if (priorConsecutive >= maxRestarts) {
    return {
      restart: false,
      reason:
        `it has now died ${priorConsecutive} times in a row without staying up for ` +
        `${Math.round(healthyAfterMs / 1000)}s — this is a crash loop, not a blip`,
      consecutive: priorConsecutive,
    };
  }

  return {
    restart: true,
    reason: healthy
      ? `it served for ${Math.round(upMs / 1000)}s and then ` +
        (signal ? `was killed by ${signal}` : "exited")
      : `it died after only ${(upMs / 1000).toFixed(1)}s` +
        (signal ? ` (killed by ${signal})` : ""),
    consecutive: priorConsecutive + 1,
  };
}

/**
 * Run `launch` and keep re-running it for as long as the policy above says the
 * server should still be serving.
 *
 * `launch(attempt)` must resolve with `{ served, code, signal }` — the shape
 * scripts/start.mjs's `runProduction` already returns — where `served` reports
 * whether the process ever answered a request. It is awaited for the process's
 * whole lifetime, so its resolution IS the death being reacted to.
 *
 * `prepareRestart(attempt)` runs between a death and the next launch and may veto
 * it by resolving false. scripts/start.mjs uses it to wait for the port to be
 * released: a relaunch that raced the dying process's socket would fail instantly
 * on EADDRINUSE and burn the whole restart budget on an artefact of the timing.
 *
 * Resolves `{ outcome, restarts, reason }` with the LAST run's outcome, so the
 * caller's existing exit-code/signal handling is unchanged — it just now applies
 * to the run that finally ended things rather than to the first hiccup.
 *
 * @param {{
 *   launch: (attempt: number) => Promise<{served: boolean, code: number|null, signal: string|null}>,
 *   prepareRestart?: (attempt: number) => Promise<boolean>,
 *   shouldStop?: () => boolean,
 *   maxRestarts?: number,
 *   healthyAfterMs?: number,
 *   backoffMs?: number,
 *   maxBackoffMs?: number,
 *   log?: (message: string) => void,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} opts
 */
export async function superviseServer({
  launch,
  prepareRestart,
  shouldStop = () => false,
  maxRestarts = DEFAULT_MAX_RESTARTS,
  healthyAfterMs = DEFAULT_HEALTHY_MS,
  backoffMs = DEFAULT_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  log = console.error,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let consecutive = 0;
  let restarts = 0;

  for (let attempt = 1; ; attempt += 1) {
    const startedAt = now();
    const outcome = await launch(attempt);
    const upMs = now() - startedAt;

    const decision = decideRestart({
      served: outcome.served,
      signal: outcome.signal,
      upMs,
      consecutive,
      stopping: shouldStop(),
      maxRestarts,
      healthyAfterMs,
    });
    consecutive = decision.consecutive;

    if (!decision.restart) {
      // Only worth a line when a server that HAD been serving is now staying
      // down — the other exits are the caller's own well-reported paths.
      if (outcome.served && !shouldStop()) {
        log(
          `[supervise] Not restarting the server: ${decision.reason}. The port is now ` +
            "unbound, so every route will read as timed out rather than as an error. " +
            "Look above for what the server printed as it died.",
        );
      }
      return { outcome, restarts, reason: decision.reason };
    }

    const delayMs = Math.min(maxBackoffMs, backoffMs * consecutive);
    log(
      `[supervise] The server stopped serving — ${decision.reason}. Restarting it ` +
        `(attempt ${consecutive} of ${maxRestarts}) in ${delayMs}ms rather than leaving ` +
        "the port unbound: an unbound port black-holes connections instead of " +
        "refusing them, so every route — including static ones like / and /login — " +
        "would read as timed out for the rest of this run.",
    );
    await sleep(delayMs);

    if (shouldStop()) return { outcome, restarts, reason: "shutting down" };

    if (prepareRestart && !(await prepareRestart(attempt + 1))) {
      return { outcome, restarts, reason: "the port could not be reclaimed for a restart" };
    }
    if (shouldStop()) return { outcome, restarts, reason: "shutting down" };

    restarts += 1;
  }
}
