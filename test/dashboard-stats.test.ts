import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import { closePool, withAdminContext, type Identity } from "../lib/db";
import { dashboardOverviewStats } from "../lib/dashboard";

/**
 * Dashboard overview KPI counts (review-hardening-dashboard-001).
 *
 * `docs/RISKY-DEFERRED.md` flagged this as the one loose end left after the
 * live-counts change: "no dedicated data-test for the counts yet (low risk —
 * the counts are RLS-scoped by construction)". This suite is that test —
 * proving the claim rather than assuming it, the same way `programs-rls.test.ts`
 * and `roster-engagement-view.test.ts` prove their own tenant-scoped queries.
 *
 * Requires a real PostgreSQL 16 instance (provided in CI via DATABASE_URL).
 * Skipped locally with a notice when DATABASE_URL is absent.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn(
    "[dashboard-stats.test] DATABASE_URL not set — skipping (runs in CI).",
  );
}

type Seed = {
  gymA: string;
  gymB: string;
  gymEmpty: string;
};

const seed = {} as Seed;
const staff = (tenantId: string): Identity => ({ tenantId, role: "staff" });

describe.skipIf(!hasDb)("dashboardOverviewStats", () => {
  beforeAll(async () => {
    await runMigrations();
    await withAdminContext(async (c) => {
      const gymA = (
        await c.query("insert into gym (name) values ('Dash Gym A') returning id")
      ).rows[0].id as string;
      const gymB = (
        await c.query("insert into gym (name) values ('Dash Gym B') returning id")
      ).rows[0].id as string;
      const gymEmpty = (
        await c.query("insert into gym (name) values ('Dash Gym Empty') returning id")
      ).rows[0].id as string;

      // Gym A: 2 members (1 active, 1 inactive), 1 program, 1 active
      // assignment, 1 pending suggestion.
      const memberActive = (
        await c.query(
          "insert into member (tenant_id, full_name, status) values ($1, 'Active Mem', 'active') returning id",
          [gymA],
        )
      ).rows[0].id as string;
      await c.query(
        "insert into member (tenant_id, full_name, status) values ($1, 'Inactive Mem', 'inactive')",
        [gymA],
      );
      const program = (
        await c.query(
          "insert into program (tenant_id, name) values ($1, 'Dash Program') returning id",
          [gymA],
        )
      ).rows[0].id as string;
      await c.query(
        "insert into program_assignment (tenant_id, program_id, member_id, status) values ($1, $2, $3, 'active')",
        [gymA, program, memberActive],
      );
      await c.query(
        `insert into suggestions
           (tenant_id, kind, member_id, headline, evidence, strength, status, source, dedupe_key)
         values ($1, 'at_risk_brief', $2, 'Went quiet', '[{"source":"test"}]'::jsonb, 'weak', 'pending', 'rules:test', 'dash-test-1')`,
        [gymA, memberActive],
      );

      // Gym B: a different member/program/assignment count, to prove gym A's
      // stats do not pick up gym B's rows.
      const memberB1 = (
        await c.query(
          "insert into member (tenant_id, full_name, status) values ($1, 'B Mem 1', 'active') returning id",
          [gymB],
        )
      ).rows[0].id as string;
      await c.query(
        "insert into member (tenant_id, full_name, status) values ($1, 'B Mem 2', 'active')",
        [gymB],
      );
      await c.query(
        "insert into member (tenant_id, full_name, status) values ($1, 'B Mem 3', 'active')",
        [gymB],
      );
      const programB = (
        await c.query(
          "insert into program (tenant_id, name) values ($1, 'B Program') returning id",
          [gymB],
        )
      ).rows[0].id as string;
      await c.query(
        "insert into program_assignment (tenant_id, program_id, member_id, status) values ($1, $2, $3, 'active')",
        [gymB, programB, memberB1],
      );

      Object.assign(seed, { gymA, gymB, gymEmpty });
    });
  });

  afterAll(async () => {
    await closePool();
  });

  it("counts only the caller's own gym, correctly per column", async () => {
    const stats = await dashboardOverviewStats(staff(seed.gymA));
    expect(stats).toEqual({
      members: 2,
      activeMembers: 1,
      programs: 1,
      activeAssignments: 1,
      pendingSuggestions: 1,
    });
  });

  it("does not leak another tenant's rows into the count", async () => {
    const statsA = await dashboardOverviewStats(staff(seed.gymA));
    const statsB = await dashboardOverviewStats(staff(seed.gymB));

    // Gym B's larger member count and zero suggestions prove the two calls
    // are not aggregating the same underlying rows.
    expect(statsB.members).toBe(3);
    expect(statsB.activeAssignments).toBe(1);
    expect(statsB.pendingSuggestions).toBe(0);
    expect(statsA.members).not.toBe(statsB.members);
  });

  it("returns all zeros for a gym with no data, not null/undefined", async () => {
    const stats = await dashboardOverviewStats(staff(seed.gymEmpty));
    expect(stats).toEqual({
      members: 0,
      activeMembers: 0,
      programs: 0,
      activeAssignments: 0,
      pendingSuggestions: 0,
    });
  });
});
