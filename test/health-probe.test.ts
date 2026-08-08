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

  /**
   * The `auth` field exists so that "the login page renders but nobody can sign
   * in" is visible from OUTSIDE the process. /login and /portal/login are static,
   * so a deployment with no auth service serves them perfectly and then rejects
   * every credential — indistinguishable from a healthy deploy to any check that
   * only fetches the pages, while the whole dashboard and portal sit unreachable
   * behind them. scripts/deploy.mjs reads this field for exactly that reason.
   */
  describe("auth readiness", () => {
    const AUTH_VARS = [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    ] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of AUTH_VARS) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
      queryMock.mockResolvedValue({ rows: [{ "?column?": 1 }] });
    });

    afterEach(() => {
      for (const key of AUTH_VARS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    it("reports auth as configured when both variables are set", async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://auth.example.test";
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
      const { GET } = await import("@/app/api/health/route");

      expect((await (await GET()).json()).auth).toBe("configured");
    });

    it("reports auth as unconfigured when a variable is missing", async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://auth.example.test";
      const { GET } = await import("@/app/api/health/route");

      expect((await (await GET()).json()).auth).toBe("unconfigured");
    });

    it("treats a whitespace-only variable as unconfigured, as sign-in does", async () => {
      // Matches lib/auth/supabase.ts's own trimming — a half-filled .env or a CI
      // secret that resolved to "" must not read as a working auth service.
      process.env.NEXT_PUBLIC_SUPABASE_URL = "   ";
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
      const { GET } = await import("@/app/api/health/route");

      expect((await (await GET()).json()).auth).toBe("unconfigured");
    });

    it("does not let missing auth config fail the probe", async () => {
      // Readiness loops (scripts/dev.mjs, the CI smoke step) gate on this status;
      // a 503 here would take them down on every environment without an auth
      // service, which is why `auth` is informational like `email`.
      const { GET } = await import("@/app/api/health/route");
      const res = await GET();

      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    });
  });
});
