import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Authorisation on /api/tasks/dispatch.
 *
 * This endpoint sends email to members. An unauthenticated version of it is an
 * abuse primitive — anyone who finds the URL can make the app mail its own
 * members repeatedly — so the auth behaviour is pinned here, including the case
 * that is easiest to get wrong: what happens when the secret is not configured
 * at all. Failing OPEN there would be the worst possible default, because it is
 * also the state a fresh deployment starts in.
 *
 * `dispatchDueTasks` is mocked: this suite is about the gate, and the real thing
 * needs a database.
 */

const dispatchDueTasks = vi.hoisted(() => vi.fn());

vi.mock("../lib/task-handlers", () => ({ dispatchDueTasks }));
vi.mock("../lib/observability/monitoring", () => ({
  captureException: vi.fn(async () => {}),
}));

const SECRET = "test-secret-value-0123456789abcdef";
let savedSecret: string | undefined;

beforeEach(() => {
  savedSecret = process.env.CRON_SECRET;
  dispatchDueTasks.mockReset();
  dispatchDueTasks.mockResolvedValue({
    claimed: 2,
    succeeded: 2,
    failed: 0,
    enqueued: 5,
  });
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedSecret;
});

function request(token?: string): Request {
  return new Request("https://app.example.test/api/tasks/dispatch", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function route() {
  return import("../app/api/tasks/dispatch/route");
}

describe("dispatch authorisation", () => {
  it("runs the queue for a correct bearer token", async () => {
    process.env.CRON_SECRET = SECRET;
    const { POST } = await route();

    const res = await POST(request(SECRET));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.claimed).toBe(2);
    expect(body.enqueued).toBe(5);
    expect(dispatchDueTasks).toHaveBeenCalledOnce();
  });

  it("rejects a wrong token without dispatching", async () => {
    process.env.CRON_SECRET = SECRET;
    const { POST } = await route();

    const res = await POST(request("wrong-token-of-the-same-length-000"));
    expect(res.status).toBe(401);
    expect(dispatchDueTasks).not.toHaveBeenCalled();
  });

  it("rejects a missing Authorization header", async () => {
    process.env.CRON_SECRET = SECRET;
    const { POST } = await route();

    const res = await POST(request());
    expect(res.status).toBe(401);
    expect(dispatchDueTasks).not.toHaveBeenCalled();
  });

  it("rejects a token that is a prefix of the secret", async () => {
    // Guards against a length-insensitive comparison.
    process.env.CRON_SECRET = SECRET;
    const { POST } = await route();

    const res = await POST(request(SECRET.slice(0, 10)));
    expect(res.status).toBe(401);
    expect(dispatchDueTasks).not.toHaveBeenCalled();
  });

  it("refuses everything when CRON_SECRET is unset, rather than defaulting to open", async () => {
    delete process.env.CRON_SECRET;
    const { POST } = await route();

    const res = await POST(request("anything"));
    // 503, not 401: the request may have been correct — the DEPLOYMENT cannot
    // run scheduled work, and reporting that as an auth failure sends an
    // operator hunting for the wrong problem.
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/CRON_SECRET is unset/);
    expect(dispatchDueTasks).not.toHaveBeenCalled();
  });

  it("accepts GET, which is what Vercel Cron issues", async () => {
    process.env.CRON_SECRET = SECRET;
    const { GET } = await route();

    const res = await GET(request(SECRET));
    expect(res.status).toBe(200);
    expect(dispatchDueTasks).toHaveBeenCalledOnce();
  });

  it("is never cached", async () => {
    // A cached dispatch response would make the scheduler a no-op that reports
    // success forever.
    process.env.CRON_SECRET = SECRET;
    const { POST } = await route();

    const res = await POST(request(SECRET));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reports a database failure as 500 without throwing out of the route", async () => {
    process.env.CRON_SECRET = SECRET;
    dispatchDueTasks.mockRejectedValue(new Error("connection refused"));
    const { POST } = await route();

    const res = await POST(request(SECRET));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/connection refused/);
  });
});
