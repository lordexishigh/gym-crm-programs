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
  if (monitoringUrl) await postWebhook(monitoringUrl, event);

  // 3) Alert sink for critical failures.
  if (severity === "critical") {
    const alertUrl = process.env.ALERT_WEBHOOK_URL;
    if (alertUrl) {
      await postWebhook(alertUrl, { ...event, alert: true });
    } else if (monitoringUrl) {
      // No dedicated alert sink — flag the monitoring event as an alert so the
      // backend can route it. Avoids double-sending when both point at one URL.
      await postWebhook(monitoringUrl, { ...event, alert: true });
    }
  }

  return id;
}
