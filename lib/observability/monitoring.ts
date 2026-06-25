/**
 * Error monitoring + alerting (beta-hardening-001).
 *
 * `captureException` is the single entry point for "something went wrong":
 *   1. It always writes a structured `error` log line (so the failure is
 *      searchable even with no external service configured).
 *   2. If `MONITORING_WEBHOOK_URL` is set, it POSTs the event there — this is
 *      the "errors are monitored" sink (a generic JSON webhook that fronts
 *      Sentry, Logflare, an internal collector, etc.).
 *   3. For `critical` severity it ALSO POSTs to `ALERT_WEBHOOK_URL` (falling
 *      back to the monitoring webhook with `alert: true`) — this is the
 *      "critical failures raise alerts" path (e.g. a Slack/PagerDuty webhook).
 *
 * It is best-effort and NEVER throws: capturing an error must not itself fail
 * the request. It returns a short correlation id that the UI surfaces to the
 * user, so a support report can be tied back to the exact logged event.
 *
 * Dependency-free (global `fetch` + Web Crypto) so it runs in both the Node and
 * Edge runtimes that Next.js uses for instrumentation/route handlers.
 */

import { logger } from "./logger";

export type Severity = "warning" | "error" | "critical";

export type ErrorContext = {
  /** Where the capture happened, e.g. "onRequestError", "resend-webhook". */
  source?: string;
  /** Defaults to "error". `critical` additionally raises an alert. */
  severity?: Severity;
  /**
   * A pre-existing correlation id (e.g. Next.js' `error.digest`). When given it
   * is reused as the returned id so the client-rendered error page and the
   * server log line share one identifier; otherwise a fresh one is generated.
   */
  correlationId?: string;
  /** Any extra structured fields (route, tenant, member, etc.). */
  [key: string]: unknown;
};

/** Generate a short correlation id. Uses Web Crypto (Node 20 + Edge). */
export function newCorrelationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Extremely defensive: crypto should always be present in our runtimes.
    return "err_" + Math.abs(Date.now()).toString(36);
  }
}

/** Normalise any thrown value into a {name, message, stack} triple. */
function describeError(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "NonError", message: String(error) };
}

/** Fire a webhook best-effort. Swallows every failure; never throws. */
async function postWebhook(url: string, payload: unknown): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch (err) {
    // A failing monitoring sink must not cascade. Record it locally only.
    logger.warn("monitoring webhook delivery failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Capture an error: log it, forward it to the monitoring sink, and (for
 * critical severity) raise an alert. Returns the correlation id.
 */
export async function captureException(
  error: unknown,
  context: ErrorContext = {},
): Promise<string> {
  const { source, severity = "error", correlationId, ...extra } = context;
  const id = correlationId || newCorrelationId();
  const described = describeError(error);

  // 1) Always log, structured. The stack stays in logs only — never in a
  //    response body (see the error boundaries / friendly messages).
  logger.error("captured exception", {
    correlationId: id,
    source,
    severity,
    error: described,
    ...extra,
  });

  const event = {
    type: "exception",
    correlationId: id,
    severity,
    source: source ?? "unknown",
    error: described,
    context: extra,
    ts: new Date().toISOString(),
  };

  // 2) Monitoring sink.
  const monitoringUrl = process.env.MONITORING_WEBHOOK_URL;
  const alertUrl = process.env.ALERT_WEBHOOK_URL;
  let delivered = false;
  if (monitoringUrl) {
    await postWebhook(monitoringUrl, event);
    delivered = true;
  }

  // 3) Alert sink for critical failures.
  if (severity === "critical") {
    if (alertUrl) {
      await postWebhook(alertUrl, { ...event, alert: true });
      delivered = true;
    } else if (monitoringUrl) {
      // No dedicated alert sink — flag the monitoring event as an alert so the
      // backend can route it. Avoids double-sending when both point at one URL.
      await postWebhook(monitoringUrl, { ...event, alert: true });
    }
  }

  // 4) Loud-misconfiguration guard. The user-facing error boundaries promise the
  //    team "has been notified" — but that is only TRUE when a sink is configured.
  //    If a real failure (error/critical) was captured with NO delivery channel,
  //    say so explicitly so the gap is visible in logs instead of silent: the
  //    event was recorded but nobody was actually paged. (Warnings — perf-budget
  //    breaches and the like — are log-only by design, so they don't trip this.)
  if (!delivered && severity !== "warning") {
    logger.warn(
      "alerting not configured: captured exception was logged only, not delivered",
      {
        correlationId: id,
        severity,
        hint: "set MONITORING_WEBHOOK_URL (and optionally ALERT_WEBHOOK_URL) so error/critical events reach a person",
      },
    );
  }

  return id;
}

/**
 * Report an error that a server action or route handler CAUGHT and turned into a
 * friendly return value instead of rethrowing (beta-hardening-001).
 *
 * Such an error never escapes to Next.js' `onRequestError`, so without this it
 * would be invisible to monitoring even though the user saw a failure. This
 * routes it through the same `captureException` path (severity "error" by
 * default — logged + monitored, but not paged) so the staff mutation surface is
 * observable too. Best-effort and never throws; returns the correlation id.
 */
export async function reportHandledError(
  error: unknown,
  source: string,
  context: Omit<ErrorContext, "source"> = {},
): Promise<string> {
  return captureException(error, { source, ...context });
}
