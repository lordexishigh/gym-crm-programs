import { test, expect } from "@playwright/test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { recordServerActionResponses } from "./action-trace";

/**
 * Covers the #26 diagnostic recorder itself.
 *
 * The recorder gets one chance to be right: #26 reproduces intermittently in
 * CI, and a recorder that silently attached nothing would read as "the payload
 * was fine" — the same count-without-its-population mistake this defect has
 * already cost twice. An earlier version of the recorder read the body via
 * `page.on("response")`; this suite is what caught that Playwright refuses a
 * 303's body outright, so that version could never have worked.
 *
 * Needs no database and no app — a stand-in returns the flight content type.
 */

const COMPLETE = '0:{"a":1}\n1:["done"]\n';
// Truncated mid-row and never ended: the exact shape the recorder exists to
// make visible, and the one a network-level hook reports as a healthy body.
const TRUNCATED = '0:{"a":1}\n1:["truncated-mid-row"';

let server: Server;
let base: string;
/** Held open so the "never closes" case is real rather than simulated. */
let openResponses: ServerResponse[] = [];

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST") {
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

test.afterAll(
  () => new Promise<void>((resolve) => server.close(() => resolve())),
);

// `page.evaluate` serialises the function, so nothing may be closed over — the
// url and path have to travel as an argument.
const post = ({ url, path }: { url: string; path: string }) =>
  fetch(url + path, { method: "POST", body: "x" })
    .then((r) => r.text())
    .catch(() => "");

test("attaches a completed flight payload verbatim", async ({ page }) => {
  recordServerActionResponses(page);
  await page.goto(base);
  await page.evaluate(post, { url: base, path: "/ok" });

  await expect
    .poll(() => test.info().attachments.length, { timeout: 10_000 })
    .toBeGreaterThan(0);

  const attachment = test.info().attachments[0];
  expect(attachment.name).toContain("server-action-closed");

  const body = attachment.body?.toString("utf8") ?? "";
  expect(body).toContain("status: 303");
  expect(body).toContain("outcome: closed");
  expect(body).toContain("x-action-redirect: /dashboard/members/abc;push");
  expect(body).toContain("x-action-revalidated: [[],1,0]");
  // The payload must survive untouched — the recorder reports, it does not judge.
  expect(body).toContain(COMPLETE.trimEnd());
});

test("reports a stream that never closes, while it is still open", async ({
  page,
}) => {
  recordServerActionResponses(page);
  await page.goto(base);
  // Not awaited: this request never settles, which is the point.
  void page.evaluate(post, { url: base, path: "/hang" });

  await expect
    .poll(() => test.info().attachments.length, { timeout: 15_000 })
    .toBeGreaterThan(0);

  const body = test.info().attachments[0].body?.toString("utf8") ?? "";
  expect(body).toContain("outcome: still-open");
  // The partial bytes React was left waiting on must be legible.
  expect(body).toContain(TRUNCATED);
  expect(body).toContain('last row: 1:["truncated-mid-row"');
});

test("leaves non-action traffic unrecorded", async ({ page }) => {
  recordServerActionResponses(page);
  await page.goto(base);
  await page.waitForTimeout(500);
  expect(test.info().attachments).toHaveLength(0);
});
