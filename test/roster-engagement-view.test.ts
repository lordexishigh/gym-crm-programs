import { describe, expect, it } from "vitest";
import { memberEngagementLevel } from "../lib/workout-logs";
import { memberRosterWhere, parseRosterFilters, rosterListSql } from "../lib/members";

/**
 * Roster engagement signal (review-hardening-roster-engagement-001).
 *
 * These are PURE checks — no database needed. They pin the two guarantees the
 * acceptance criteria call out without a live DB:
 *   - the at-risk classification logic (so the view and this test cannot drift);
 *   - the issued SQL aggregates `workout_log` in a SINGLE join (no N+1) with the
 *     window/limit/offset placeholders following the WHERE-clause params.
 * The RLS scoping itself is exercised by `workout-logs-rls.test.ts` (DB suite).
 */

describe("memberEngagementLevel", () => {
  it("is 'active' when there is at least one session in the window", () => {
    expect(
      memberEngagementLevel({ recentSessions: 3, lastCompletedAt: "2026-06-20T10:00:00Z" }),
    ).toBe("active");
    // Recent sessions win even if (impossibly) lastCompletedAt were missing.
    expect(memberEngagementLevel({ recentSessions: 1, lastCompletedAt: null })).toBe(
      "active",
    );
  });

  it("is 'at-risk' when the member logged before but not inside the window", () => {
    expect(
      memberEngagementLevel({ recentSessions: 0, lastCompletedAt: "2025-01-01T10:00:00Z" }),
    ).toBe("at-risk");
  });

  it("is 'none' when the member has never logged a session", () => {
    expect(memberEngagementLevel({ recentSessions: 0, lastCompletedAt: null })).toBe(
      "none",
    );
  });
});

describe("rosterListSql", () => {
  it("aggregates workout_log exactly once (single join, no N+1)", () => {
    const sql = rosterListSql("", 0);
    expect((sql.match(/from workout_log/g) ?? []).length).toBe(1);
    expect(sql).toContain("left join");
    expect(sql).toContain("group by member_id");
  });

  it("places window/limit/offset placeholders after the clause params", () => {
    // A search + status filter produces two clause params ($1, $2); the window,
    // limit and offset must then be $3, $4, $5.
    const filters = parseRosterFilters({ q: "jane", status: "active" });
    const { clause, params } = memberRosterWhere(filters);
    expect(params).toHaveLength(2);

    const sql = rosterListSql(clause, params.length);
    expect(sql).toContain("make_interval(days => $3)");
    expect(sql).toContain("limit $4 offset $5");
  });

  it("uses $1 for the window when there are no clause params", () => {
    const sql = rosterListSql("", 0);
    expect(sql).toContain("make_interval(days => $1)");
    expect(sql).toContain("limit $2 offset $3");
  });
});
