import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression guard for the readiness probe's bounded wait.
 *
 * An unreachable Postgres does not fail fast on its own — `pg` inherits the OS
 * TCP connect timeout, so /api/health used to sit for ~21s before answering 503.
 * A probe slower than the thing probing it is worse than useless: the monitor or
 * CI readiness loop times out with no body, and a merely DEGRADED app is
 * indistinguishable from a CRASHED one. These tests pin the contract that the
 * route always answers within its own budget and names the reason.
 *
 * `lib/db` is mocked so no real connection is attempted (the suite has no
 * Postgres); the pool stand-in reproduces the pathological case exactly — a
 * query promise that never settles.
 */

const queryMock = vi.fn();

vi.mock("@/lib/db", () => ({
  getPool: () => ({ query: queryMock }),
}));

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    // Keep the test fast; the route reads this on every request.
    process.env.HEALTH_DB_TIMEOUT_MS = "150";
  });

  afterEach(() => {
    delete process.env.HEALTH_DB_TIMEOUT_MS;
  });

  it("reports 503 within its budget when the database never responds", async () => {
    // The pathological case: a connection that hangs forever.
    queryMock.mockReturnValue(new Promise(() => {}));
    const { GET } = await import("@/app/api/health/route");

    const started = Date.now();
    const res = await GET();
    const elapsed = Date.now() - started;

    expect(res.status).toBe(503);
    // The whole point: bounded, not the ~21s OS timeout. Generous ceiling so a
    // loaded CI runner cannot flake it, but far below the unbounded behaviour.
    expect(elapsed).toBeLessThan(3_000);

    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe("degraded");
    expect(body.db).toBe("down");
    // An operator needs to know WHY, not just that it is down.
    expect(body.db_error).toMatch(/exceeded 150ms/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reports 503 when the database refuses the connection", async () => {
    queryMock.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
    const { GET } = await import("@/app/api/health/route");

    const res = await GET();
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.db).toBe("down");
    expect(body.db_error).toMatch(/ECONNREFUSED/);
  });

  it("reports 503 rather than throwing when DATABASE_URL is unset", async () => {
    // `getPool()` throws synchronously in this case — a misconfigured deploy must
    // still get a readable probe response, not a 500 from an unhandled throw.
    queryMock.mockImplementation(() => {
      throw new Error("DATABASE_URL is not set.");
    });
    const { GET } = await import("@/app/api/health/route");

    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).db_error).toMatch(/DATABASE_URL is not set/);
  });

  it("reports 200 with latency when the database answers", async () => {
    queryMock.mockResolvedValue({ rows: [{ "?column?": 1 }] });
    const { GET } = await import("@/app/api/health/route");

    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("ok");
    expect(body.db).toBe("up");
    expect(typeof body.db_latency_ms).toBe("number");
    // A healthy probe carries no error field at all.
    expect(body.db_error).toBeUndefined();
  });
});
