import { test, expect } from "@playwright/test";
import { createServer, type Server, type ServerResponse } from "node:http";
import {
  flushFlightRecords,
  recordedFlightCount,
  recordServerActionResponses,
} from "./action-trace";

/**
 * Covers the #26 diagnostic recorder itself.
 *
 * These exist because the recorder already failed once in the only way that
 * matters. Version one matched on the RESPONSE content-type, passed every test
 * here, and then attached **nothing** on the CI run where #26 finally
 * reproduced — and an empty attachment list is indistinguishable from "no
 * Server Action misbehaved". A recorder that reports silence as health is worse
 * than no recorder, so what is pinned below is mostly *reporting under adverse
 * conditions*, not the happy path.
 *
 * Needs no database and no app: a stand-in returns the flight content type.
 */

const COMPLETE = '0:{"a":1}\n1:["done"]\n';
// Truncated mid-row and never ended: the shape the recorder exists to expose,
// and the one a network-level hook reports as a perfectly healthy body.
const TRUNCATED = '0:{"a":1}\n1:["truncated-mid-row"';

let server: Server;
let base: string;
/** Held open so the "never ends" case is real rather than simulated. */
let openResponses: ServerResponse[] = [];

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST") {
      if (req.url === "/no-ct") {
        // A Server Action whose response carries NO usable content-type —
        // version one dropped this silently, which is the bug.
        res.writeHead(303, { "x-action-redirect": "/dashboard;push" });
        res.end(COMPLETE);
        return;
      }
      res.writeHead(303, {
        "content-type": "text/x-component",
        "x-action-redirect": "/dashboard/members/abc;push",
        "x-action-revalidated": "[[],1,0]",
      });
      if (req.url === "/hang") {
        res.write(TRUNCATED);
        openResponses.push(res); // deliberately never ended
        return;
      }
      res.end(COMPLETE);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body>ok</body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

test.afterEach(() => {
  for (const res of openResponses) res.end();
  openResponses = [];
});

test.afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** `page.evaluate` serialises the function, so nothing may be closed over. */
const post = ({ url, path, actionHeader }: {
  url: string; path: string; actionHeader: boolean;
}) =>
  fetch(url + path, {
    method: "POST",
    body: "x",
    headers: actionHeader ? { "next-action": "abc123" } : {},
  })
    .then((r) => r.text())
    .catch(() => "");

const names = () => test.info().attachments.map((a) => a.name);
/** Records of actual Server Action traffic — not the two bookkeeping attachments. */
const BOOKKEEPING = ["recorder-installed", "recorder-probe"];
const flightNames = () =>
  names().filter((n) => !BOOKKEEPING.some((b) => n.includes(b)));
/** Always skips bookkeeping — their names also start "server-action-". */
const bodyOf = (needle: string) =>
  test.info().attachments
    .find((a) => a.name.includes(needle)
                 && !BOOKKEEPING.some((b) => a.name.includes(b)))
    ?.body?.toString("utf8") ?? "";

test("records that the init script installed, so silence is never ambiguous", async ({
  page,
}) => {
  await recordServerActionResponses(page);
  await page.goto(base);

  await expect.poll(recordedFlightCount, { timeout: 10_000 }).toBeGreaterThan(0);
  await flushFlightRecords();
  expect(names().some((n) => n.includes("recorder-installed"))).toBe(true);
  expect(
    await page.evaluate(() => (window as unknown as {
      __flightRecorderInstalled?: boolean }).__flightRecorderInstalled),
  ).toBe(true);
});

test("attaches a completed flight payload verbatim", async ({ page }) => {
  await recordServerActionResponses(page);
  await page.goto(base);
  await page.evaluate(post, { url: base, path: "/ok", actionHeader: true });

  await expect.poll(recordedFlightCount, { timeout: 10_000 }).toBeGreaterThan(1);
  await flushFlightRecords();

  const body = bodyOf("server-action-closed");
  expect(body).toContain("status: 303");
  expect(body).toContain("outcome: closed");
  expect(body).toContain("x-action-redirect: /dashboard/members/abc;push");
  // The payload must survive untouched — the recorder reports, it does not judge.
  expect(body).toContain(COMPLETE.trimEnd());
});

test("matches on the REQUEST header, not the response shape", async ({ page }) => {
  /**
   * The regression that produced zero attachments on CI. Keying detection on
   * the response meant any surprise there — a filtered type, a missing
   * content-type, a redirect — read as "not a Server Action" and vanished.
   */
  await recordServerActionResponses(page);
  await page.goto(base);
  await page.evaluate(post, { url: base, path: "/no-ct", actionHeader: true });

  await expect.poll(recordedFlightCount, { timeout: 10_000 }).toBeGreaterThan(1);
  await flushFlightRecords();
  expect(flightNames().length).toBeGreaterThan(0);
  expect(bodyOf("server-action-")).toContain("matched on: request:next-action");
});

test("reports a stream that never ends, while it is still open", async ({ page }) => {
  await recordServerActionResponses(page);
  await page.goto(base);
  // Not awaited: this request never settles, which is the point.
  void page.evaluate(post, { url: base, path: "/hang", actionHeader: true });

  await expect.poll(recordedFlightCount, { timeout: 15_000 }).toBeGreaterThan(1);
  await flushFlightRecords();
  expect(names().some((n) => n.includes("still-open"))).toBe(true);

  const body = bodyOf("still-open");
  expect(body).toContain("outcome: still-open");
  // The partial bytes React was left waiting on must be legible.
  expect(body).toContain(TRUNCATED);
  expect(body).toContain('last row: 1:["truncated-mid-row"');
});

test("leaves non-action traffic unrecorded", async ({ page }) => {
  await recordServerActionResponses(page);
  await page.goto(base);
  await page.waitForTimeout(500);
  await flushFlightRecords();
  // The install sentinel and the probe are expected; no flight records are.
  expect(flightNames()).toHaveLength(0);
});
