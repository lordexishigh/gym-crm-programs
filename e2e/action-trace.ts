import { test, type Page } from "@playwright/test";

/**
 * Records Server Action responses (the RSC "flight" payload) as test attachments.
 *
 * WHY THIS EXISTS
 *
 * Issue #26 — the production client applies a Server Action's redirect and then
 * never commits the navigation — was diagnosed as far as a retained Playwright
 * trace can take it, and stopped on one missing input.
 *
 * What that trace already proves, and what this must NOT re-collect:
 *   - the action completes (303 in ~90ms, `receive` recorded),
 *   - `x-action-redirect` comes back and the row was written,
 *   - the client reacts — it fetches the destination route's chunk ~7ms after
 *     the redirect header lands, and that chunk completes,
 *   - the page then sits for 29.9s with `pending` still true,
 *   - and the hang is SILENT: zero `console` messages, zero `pageError` events,
 *     both captured by default in the pinned Playwright (verified by probe).
 *
 * The one input left unobserved is the payload React was reading. The network
 * layer cannot supply it: a Server Action redirect is a 303, and Playwright
 * refuses a redirect response's body outright ("Response body is unavailable
 * for redirect responses"). So this instruments `window.fetch`, where React
 * consumes the stream.
 *
 * WHY IT REPORTS EVEN WHEN IT LEARNS NOTHING
 *
 * The first version matched on the RESPONSE's content-type. On the run where
 * #26 finally reproduced it attached **zero** records while its own unit tests
 * passed — and an empty attachment list is indistinguishable from "no Server
 * Action misbehaved". That is the count-without-its-population defect, built
 * into the instrument meant to catch it.
 *
 * Two changes follow, and they matter more than what gets recorded:
 *
 * 1. **Detection is on the REQUEST.** A Server Action carries a `next-action`
 *    header, readable from the fetch arguments no matter what the response
 *    turns out to be — filtered, opaque, redirected or unreadable. Matching on
 *    the response meant any surprise in its shape read as "not a Server Action".
 * 2. **Every matched call is reported**, including ones whose body cannot be
 *    read, and an `installed` sentinel is recorded on first navigation. So
 *    "never installed", "installed but saw nothing", and "saw it and could not
 *    read it" are three distinct outcomes rather than one silence.
 *
 * INTERFERENCE — not a passive observer. The body is piped through a
 * pass-through transform, which preserves streaming (unlike `clone()`) but is
 * still an extra queue. Four CI runs show the bug reproducing with the recorder
 * present and absent, and passing with it present and absent, so the
 * instrumentation is not the variable — but a recorded run is still not
 * bit-identical to an unrecorded one.
 */

/** Marks a Server Action request. Next sets it on the fetch, not the response. */
const ACTION_REQUEST_HEADER = "next-action";
/** Secondary net, in case a payload arrives without the request header. */
const FLIGHT_CONTENT_TYPE = "text/x-component";
/**
 * How long a flight stream may stay open before it is reported as still-open.
 * Well inside the journey's 30s `toHaveURL` budget, so the report lands during
 * the hang rather than after the test has already failed.
 */
const WATCHDOG_MS = 5_000;

type FlightRecord = {
  kind: "installed" | "flight";
  url?: string;
  status?: number;
  responseType?: string;
  matchedOn?: string;
  headers?: Record<string, string>;
  headerCount?: number;
  bodyPresent?: boolean;
  outcome?: "closed" | "still-open" | "errored";
  ms?: number;
  chunks?: number;
  bytes?: number;
  payload?: string;
  error?: string;
};

/**
 * Attach every Server Action response this page makes.
 *
 * `await` matters: both the binding and the init script must be registered
 * before the first navigation, and the previous version fired them with `void`
 * from a synchronous hook — one of two candidate causes of it recording nothing.
 */
export async function recordServerActionResponses(page: Page): Promise<void> {
  await page.exposeBinding(
    "__recordFlight",
    (_source, record: FlightRecord) => void attach(record),
  );
  await page.addInitScript(
    ({ actionHeader, contentType, watchdogMs }) => {
      const report = (record: unknown) =>
        (window as unknown as { __recordFlight?: (r: unknown) => Promise<void> })
          .__recordFlight?.(record);

      // Proves the script ran at all. Without it, "no records" cannot be told
      // apart from "never installed" — the ambiguity that cost a CI round trip.
      (window as unknown as { __flightRecorderInstalled?: boolean })
        .__flightRecorderInstalled = true;
      void report({ kind: "installed", url: location.href });

      /** Read one request header across every shape fetch() accepts. */
      const requestHeader = (args: unknown[], name: string): string | null => {
        try {
          const [input, init] = args as [RequestInfo | URL, RequestInit | undefined];
          const h = init?.headers;
          if (h) {
            if (typeof (h as Headers).get === "function") {
              return (h as Headers).get(name);
            }
            if (Array.isArray(h)) {
              const hit = h.find((p) => String(p[0]).toLowerCase() === name);
              return hit ? String(hit[1]) : null;
            }
            for (const k of Object.keys(h as Record<string, string>)) {
              if (k.toLowerCase() === name) return (h as Record<string, string>)[k];
            }
          }
          if (input && typeof (input as Request).headers?.get === "function") {
            return (input as Request).headers.get(name);
          }
        } catch {
          /* a header we cannot read is not a reason to break the request */
        }
        return null;
      };

      const original = window.fetch;
      window.fetch = async function (...args) {
        const actionId = requestHeader(args, actionHeader);
        const response = await original.apply(this, args);

        const headers: Record<string, string> = {};
        try {
          response.headers.forEach((v, k) => (headers[k] = v));
        } catch {
          /* filtered responses expose no headers; recorded as headerCount 0 */
        }

        const matchedOn = actionId
          ? "request:next-action"
          : (headers["content-type"] ?? "").includes(contentType)
            ? "response:content-type"
            : null;
        if (!matchedOn) return response;

        const base = {
          kind: "flight" as const,
          url: response.url || String(args[0]),
          status: response.status,
          responseType: response.type,
          matchedOn,
          headers,
          headerCount: Object.keys(headers).length,
          bodyPresent: Boolean(response.body),
        };

        // A matched call with no readable body is still evidence — it says the
        // response was filtered before React ever saw it. Report and move on.
        if (!response.body) {
          void report({ ...base, outcome: "errored", payload: "",
                        error: "response.body is null (filtered or empty)" });
          return response;
        }

        const started = performance.now();
        const decoder = new TextDecoder();
        let payload = "";
        let chunks = 0;
        let bytes = 0;
        let settled = false;

        const finish = (outcome: "closed" | "still-open" | "errored", error?: string) =>
          report({ ...base, outcome, error,
                   ms: Math.round(performance.now() - started),
                   chunks, bytes, payload });

        // Fires only if the stream is still open — the observation this whole
        // file exists for, so it must not wait on the stream to end.
        setTimeout(() => {
          if (!settled) void finish("still-open");
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
            void finish("closed");
          },
        });

        // 303 is legal to construct here (only 204/205/304 are null-body
        // statuses), and the headers carry over so React sees what the server
        // sent.
        try {
          return new Response(response.body.pipeThrough(passthrough), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } catch (err) {
          // Never let instrumentation change what the app receives. If the
          // response cannot be rebuilt, hand back the original and say so.
          settled = true;
          void finish("errored", err instanceof Error ? err.message : String(err));
          return response;
        }
      };
    },
    {
      actionHeader: ACTION_REQUEST_HEADER,
      contentType: FLIGHT_CONTENT_TYPE,
      watchdogMs: WATCHDOG_MS,
    },
  );

  // The page-side sentinel reports through the binding, so if the binding is
  // what is missing, the sentinel goes missing with it — which is exactly what
  // happened: the journeys produced no records AND no install sentinel, leaving
  // the two indistinguishable again. This probe runs in NODE, reads the flag
  // directly, and attaches whatever it finds including `false`. It cannot be
  // silent, which is the whole requirement.
  let probed = false;
  page.on("load", () => {
    if (probed) return; // one probe per page is enough to answer the question
    probed = true;
    void (async () => {
      let installed: unknown = "probe failed";
      try {
        installed = await page.evaluate(
          () => (window as unknown as { __flightRecorderInstalled?: boolean })
            .__flightRecorderInstalled ?? false,
        );
      } catch (err) {
        installed = `probe threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      try {
        await test.info().attach("server-action-recorder-probe.txt", {
          body: `__flightRecorderInstalled = ${String(installed)}\nurl = ${page.url()}\n`,
          contentType: "text/plain",
        });
      } catch {
        /* test already finished; nothing left to attach to */
      }
    })();
  });
}

async function attach(record: FlightRecord): Promise<void> {
  const info = test.info();

  if (record.kind === "installed") {
    // One per navigation; cheap, and its ABSENCE is the finding.
    await info.attach("server-action-recorder-installed.txt", {
      body: `init script ran at ${record.url}\n`,
      contentType: "text/plain",
    });
    return;
  }

  // A flight stream is newline-delimited rows of `<id>:<tag><json>`. Reporting
  // the last row untruncated is what makes "did this stream finish?" answerable
  // by reading it, without this file deciding what a finished stream looks like.
  const payload = record.payload ?? "";
  const rows = payload.split("\n");
  const summary = [
    `POST ${record.url}`,
    `matched on: ${record.matchedOn}`,
    `status: ${record.status}   response.type: ${record.responseType}`,
    `outcome: ${record.outcome}${record.ms !== undefined ? ` after ${record.ms}ms` : ""}`,
    ...(record.error ? [`error: ${record.error}`] : []),
    `body present: ${record.bodyPresent}   headers visible: ${record.headerCount}`,
    `chunks: ${record.chunks ?? 0}   bytes: ${record.bytes ?? 0}`,
    `flight rows: ${payload ? rows.length : 0}`,
    `last row: ${payload ? rows.at(-1) : "(no body)"}`,
    "",
    ...["x-action-redirect", "x-action-revalidated", "content-type"]
      .filter((h) => record.headers && h in record.headers)
      .map((h) => `${h}: ${record.headers![h]}`),
  ];

  const path = (() => {
    try {
      return new URL(record.url ?? "").pathname.replace(/\W+/g, "-");
    } catch {
      return "-unknown";
    }
  })();

  await info.attach(`server-action-${record.outcome}${path}.txt`, {
    body: `${summary.join("\n")}\n\n---\n\n${payload}`,
    contentType: "text/plain",
  });
}
