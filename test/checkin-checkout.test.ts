import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

/**
 * Unit tests for the check-in/check-out TOGGLE (feedback-2026-08).
 *
 * No database, same approach as checkin-pins.test.ts: `withTenantContext` is
 * stubbed to hand the callback a fake `PoolClient` that records every statement.
 * What that lets us pin down is the part this change actually introduced — the
 * branch that decides whether a scan means "arriving" or "leaving" — plus the
 * two properties that decide whether the live occupancy number can be trusted:
 *
 *   1. the direction is derived from whether a conditional UPDATE closed a row,
 *      not from a prior SELECT (so two simultaneous scans cannot both "close"
 *      the same visit and double-count), and
 *   2. an arrival INSERTs exactly once and a departure INSERTs nothing (a
 *      departure that also inserted would make the member permanently present).
 *
 * The SQL's own semantics still need Postgres and are covered by the DB-backed
 * suites; this covers the control flow around it, which is what was written.
 */

const calls: { sql: string; params: unknown[] }[] = [];

/** rowCount the stubbed `update check_ins` should report on the next call. */
let updateRowCount = 0;
/** Rows the stubbed member lookup should return. */
let memberRows: Record<string, unknown>[] = [];

vi.mock("@/lib/db", () => ({
  withTenantContext: async (
    _identity: unknown,
    fn: (c: PoolClient) => Promise<unknown>,
  ) => {
    const query = async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/^\s*update check_ins/i.test(sql)) {
        return {
          rows: Array.from({ length: updateRowCount }, () => ({ id: "ci-1" })),
          rowCount: updateRowCount,
        };
      }
      if (/^\s*insert into check_ins/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/^\s*select count/i.test(sql)) return { rows: [{ count: "3" }] };
      return { rows: memberRows, rowCount: memberRows.length };
    };
    return fn({ query } as unknown as PoolClient);
  },
}));

const {
  checkInByPin,
  currentOccupancy,
  todaysCheckIns,
  STALE_VISIT_HOURS,
  GYM_TIME_ZONE,
} = await import("../lib/checkin");

const identity = { tenantId: "gym-1", role: "staff" } as never;

const MEMBER = {
  id: "member-1",
  full_name: "Jane Athlete",
  photo_url: null,
  photo_updated_at: null,
};

beforeEach(() => {
  calls.length = 0;
  updateRowCount = 0;
  memberRows = [MEMBER];
});

const sqlOf = (re: RegExp) => calls.filter((c) => re.test(c.sql));

describe("check-in / check-out toggle", () => {
  it("records an ARRIVAL when the member has no open visit", async () => {
    updateRowCount = 0; // the conditional close matched nothing

    const result = await checkInByPin(identity, "123456");

    expect(result).toMatchObject({ ok: true, direction: "in", memberId: "member-1" });
    expect(sqlOf(/^\s*insert into check_ins/i)).toHaveLength(1);
  });

  it("records a DEPARTURE when an open visit is closed, and inserts nothing", async () => {
    updateRowCount = 1; // the conditional close matched the open visit

    const result = await checkInByPin(identity, "123456");

    expect(result).toMatchObject({ ok: true, direction: "out" });
    // The critical half: a departure must NOT also open a new visit, or the
    // member would be counted present forever.
    expect(sqlOf(/^\s*insert into check_ins/i)).toHaveLength(0);
  });

  it("closes only an OPEN visit inside the stale window (idempotent, race-safe)", async () => {
    await checkInByPin(identity, "123456");

    const update = sqlOf(/^\s*update check_ins/i)[0];
    expect(update).toBeDefined();
    // `checked_out_at is null` is what makes a double scan close one row rather
    // than overwriting an already-recorded departure time.
    expect(update!.sql).toMatch(/checked_out_at is null/i);
    // Past the window a forgotten visit must not be "closed" hours later — the
    // next scan should start a fresh visit instead.
    expect(update!.sql).toMatch(/checked_in_at > now\(\) - /i);
    expect(update!.params).toContain(String(STALE_VISIT_HOURS));
  });

  it("writes nothing at all when the PIN matches no member", async () => {
    memberRows = [];

    const result = await checkInByPin(identity, "000000");

    expect(result).toMatchObject({ ok: false });
    expect(sqlOf(/^\s*update check_ins/i)).toHaveLength(0);
    expect(sqlOf(/^\s*insert into check_ins/i)).toHaveLength(0);
  });
});

describe("today's feed", () => {
  it("anchors 'today' to the gym's local day, not the database's UTC day", async () => {
    await todaysCheckIns(identity);

    const feed = sqlOf(/from check_ins ci/i)[0];
    expect(feed).toBeDefined();
    // The regression this guards: a bare `date_trunc('day', now())` truncates in
    // the DB's timezone (UTC in production). Cyprus is UTC+2/+3, so the feed's
    // day would roll over at 02:00-03:00 local and a member who checked in at
    // 01:00 would silently vanish from "Today" mid-session.
    expect(feed!.sql).not.toMatch(/date_trunc\('day',\s*now\(\)\s*\)/);
    expect(feed!.sql).toMatch(
      /date_trunc\('day',\s*now\(\) at time zone \$2::text\)\s*at time zone \$2::text/,
    );
    expect(feed!.params).toContain(GYM_TIME_ZONE);
  });

  it("defaults the gym timezone to Cyprus", () => {
    // Env-overridable, but the shipped default must match the market — an
    // accidental UTC default is exactly the bug above wearing a config hat.
    expect(GYM_TIME_ZONE).toBe("Europe/Nicosia");
  });
});

describe("live occupancy", () => {
  it("counts distinct members with an open visit inside the window", async () => {
    const count = await currentOccupancy(identity);

    expect(count).toBe(3);
    const q = sqlOf(/^\s*select count/i)[0]!;
    // Distinct members, not rows: a stale open visit plus a fresh one for the
    // same person is still one body in the room.
    expect(q.sql).toMatch(/count\(distinct member_id\)/i);
    expect(q.sql).toMatch(/checked_out_at is null/i);
    expect(q.params).toContain(String(STALE_VISIT_HOURS));
  });
});
