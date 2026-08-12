import { test, type Page } from "@playwright/test";

/**
 * Records Server Action responses (the RSC "flight" payload) as test attachments.
 *
 * WHY THIS EXISTS
 *
 * Issue #26 — the production client applies a Server Action's redirect and then
 * never commits the navigation — was diagnosed as far as a retained Playwright
 * trace can take it, and then stopped, on exactly one missing input.
 *
 * What that trace already proves, and what this must NOT re-collect:
 *   - the action completes (303 in ~90ms, `receive` recorded, so the HTTP body
 *     finished as far as the network layer is concerned),
 *   - `x-action-redirect` comes back and the row was written,
 *   - the client reacts — it requests the destination route's chunk ~7ms after
 *     the redirect header lands, and that chunk completes,
 *   - the page then sits for 29.9s with `pending` still true,
 *   - and the hang is SILENT: zero `console` messages, zero `pageError` events,
 *     both of which this Playwright captures by default (verified by probe).
 *
 * So the client threw nothing and logged nothing, and the only input left
 * unobserved is the payload React was reading.
 *
 * WHY IT INSTRUMENTS `fetch` AND NOT `page.on("response")`
 *
 * Because the network layer cannot supply it. A Server Action redirect is a
 * 303, and Playwright refuses a redirect response's body outright —
 * "Response body is unavailable for redirect responses" (playwright-core). That
 * is the real reason the retained trace stored bodies for GETs but for neither
 * POST, and it means no response-level hook can ever answer this question. The
 * first version of this file was written that way and its own test caught it.
 *
 * Observing at `window.fetch` instead reads the stream at the point React
 * consumes it, which is also the only place that can distinguish the case that
 * matters: a body that is complete as HTTP but truncated as flight, leaving
 * React waiting on rows that never arrive without ever erroring. A stream that
 * never closes is reported WHILE it is still open (see WATCHDOG_MS) rather than
 * at teardown, so a hung test still produces the evidence.
 *
 * INTERFERENCE — this is not a passive observer. The response body is piped
 * through a pass-through transform, which preserves streaming (it does not
 * buffer the whole body the way `clone()` would) but is still an extra queue in
 * the path. A run with recording on is therefore not bit-identical to one
 * without, which matters because #26 is intermittent and timing-sensitive. If a
 * recorded run stops reproducing it, that is a result about the recorder, not
 * about the bug.
 */

/** Server Action requests and their responses both use the RSC content type. */
const FLIGHT_CONTENT_TYPE = "text/x-component";

/**
 * How long a flight stream may stay open before it is reported as still-open.
 * Well under the journey's 30s `toHaveURL` budget, so the report lands during
 * the hang rather than after the test has already failed.
 */
const WATCHDOG_MS = 5_000;

type FlightRecord = {
  url: string;
  status: number;
  headers: Record<string, string>;
  outcome: "closed" | "still-open" | "errored";
  ms: number;
  chunks: number;
  bytes: number;
  payload: string;
  error?: string;
};

/**
 * Attach every Server Action response this page makes.
 *
 * Registered per test via `test.beforeEach`, before any navigation — both the
 * binding and the init script must be in place before the document loads.
 */
export function recordServerActionResponses(page: Page): void {
  void page.exposeBinding(
    "__recordFlight",
    (_source, record: FlightRecord) => void attach(record),
  );
  void page.addInitScript(
    ({ contentType, watchdogMs }) => {
      const original = window.fetch;
      window.fetch = async function (...args) {
        const response = await original.apply(this, args);
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => (headers[k] = v));

        if (
          !(headers["content-type"] ?? "").includes(contentType) ||
          !response.body
        ) {
          return response;
        }

        const started = performance.now();
        const decoder = new TextDecoder();
        let payload = "";
        let chunks = 0;
        let bytes = 0;
        let settled = false;

        const report = (
          outcome: "closed" | "still-open" | "errored",
          error?: string,
        ) =>
          (
            window as unknown as {
              __recordFlight: (r: unknown) => Promise<void>;
            }
          ).__recordFlight({
            url: response.url,
            status: response.status,
            headers,
            outcome,
            ms: Math.round(performance.now() - started),
            chunks,
            bytes,
            payload,
            error,
          });

        // Fires only if the stream is still open — this is the observation the
        // whole file exists for, so it must not wait on the stream to end.
        setTimeout(() => {
          if (!settled) void report("still-open");
        }, watchdogMs);

        const passthrough = new TransformStream({
          transform(chunk, controller) {
            chunks += 1;
            bytes += chunk.byteLength;
            payload += decoder.decode(chunk, { stream: true });
            controller.enqueue(chunk);
          },
          flush() {
            settled = true;
            void report("closed");
          },
        });

        // The body must be re-wrapped, and a 303 is legal to construct here
        // (only 204/205/304 are null-body statuses).
        return new Response(response.body.pipeThrough(passthrough), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      };
    },
    { contentType: FLIGHT_CONTENT_TYPE, watchdogMs: WATCHDOG_MS },
  );
}

async function attach(record: FlightRecord): Promise<void> {
  // A flight stream is newline-delimited rows of `<id>:<tag><json>`. Reporting
  // the last row untruncated is what makes "did this stream finish?" answerable
  // by reading it, without this file deciding what a finished stream looks like.
  const rows = record.payload.split("\n");
  const summary = [
    `POST ${record.url}`,
    `status: ${record.status}`,
    `outcome: ${record.outcome} after ${record.ms}ms`,
    ...(record.error ? [`error: ${record.error}`] : []),
    `chunks: ${record.chunks}   bytes: ${record.bytes}`,
    `flight rows: ${rows.length}`,
    `last row: ${rows.at(-1)}`,
    "",
    ...["x-action-redirect", "x-action-revalidated", "content-type"]
      .filter((h) => h in record.headers)
      .map((h) => `${h}: ${record.headers[h]}`),
  ];

  await test
    .info()
    .attach(
      `server-action-${record.outcome}-${new URL(record.url).pathname.replace(/\W+/g, "-")}.txt`,
      {
        body: `${summary.join("\n")}\n\n---\n\n${record.payload}`,
        contentType: "text/plain",
      },
    );
}
