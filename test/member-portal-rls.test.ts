import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import {
  closePool,
  withAdminContext,
  withTenantContext,
  type Identity,
} from "../lib/db";
import { assignedPrograms } from "../lib/portal";

/**
 * Member portal read-path isolation tests (mvp-member-portal-001).
 *
 * Drives the EXACT query the portal page runs, but under a `member` identity, to
 * prove the acceptance criteria at the DB level — security is enforced by RLS,
 * not application code:
 *   - an authenticated member reads ONLY their own assigned program + exercises;
 *   - they cannot read another member's program (same gym) even by id;
 *   - they cannot read another gym's program (cross-tenant) even by id;
 *   - a member with no assignment gets an empty result (empty-state path).
 *
 * Requires a real PostgreSQL 16 instance (provided in CI via DATABASE_URL).
 * Skipped locally with a notice when DATABASE_URL is absent.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn(
    "[member-portal-rls.test] DATABASE_URL not set — skipping (runs in CI).",
  );
}

type Seed = {
  gymA: string;
  gymB: string;
  memberA1: string; // gym A, assigned progA1
  memberA2: string; // gym A, assigned progA2
  memberA3: string; // gym A, no assignment
  memberB: string; // gym B, assigned progB
  progA1: string;
  progA2: string;
  progB: string;
};

const seed = {} as Seed;
const staff = (tenantId: string): Identity => ({ tenantId, role: "staff" });
const member = (tenantId: string, memberId: string): Identity => ({
  tenantId,
  role: "member",
  memberId,
});

// The member-scoped program query is imported from `../lib/portal` (the same
// `assignedPrograms` the portal page runs) so this test exercises the real read
// path and cannot drift from it.

describe.skipIf(!hasDb)("member portal read-path isolation", () => {
  beforeAll(async () => {
    await runMigrations();
    await withAdminContext(async (c) => {
      const gym = async (name: string) =>
        (await c.query("insert into gym (name) values ($1) returning id", [name]))
          .rows[0].id as string;
      const mem = async (tenant: string, name: string) =>
        (
          await c.query(
            "insert into member (tenant_id, full_name) values ($1, $2) returning id",
            [tenant, name],
          )
        ).rows[0].id as string;
      const prog = async (tenant: string, name: string) =>
        (
          await c.query(
            "insert into program (tenant_id, name) values ($1, $2) returning id",
            [tenant, name],
          )
        ).rows[0].id as string;
      const assign = async (tenant: string, programId: string, memberId: string) =>
        c.query(
          "insert into program_assignment (tenant_id, program_id, member_id) values ($1,$2,$3)",
          [tenant, programId, memberId],
        );

      const gymA = await gym("Portal Gym A");
      const gymB = await gym("Portal Gym B");
      const memberA1 = await mem(gymA, "A One");
      const memberA2 = await mem(gymA, "A Two");
      const memberA3 = await mem(gymA, "A Three");
      const memberB = await mem(gymB, "B One");
      const progA1 = await prog(gymA, "Prog A1");
      const progA2 = await prog(gymA, "Prog A2");
      const progB = await prog(gymB, "Prog B");

      // An exercise on progA1 so we can assert exercise visibility too.
      await c.query(
        `insert into exercise (tenant_id, program_id, position, name, sets, reps, rest, notes)
         values ($1,$2,0,'Squat',5,'5','120s','brace')`,
        [gymA, progA1],
      );

      await assign(gymA, progA1, memberA1);
      await assign(gymA, progA2, memberA2);
      await assign(gymB, progB, memberB);

      Object.assign(seed, {
        gymA,
        gymB,
        memberA1,
        memberA2,
        memberA3,
        memberB,
        progA1,
        progA2,
        progB,
      });
    });
  });

  afterAll(async () => {
    await closePool();
  });

  it("a member reads only their own assigned program", async () => {
    const rows = await assignedPrograms(
      member(seed.gymA, seed.memberA1),
      seed.memberA1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(seed.progA1);
    expect(rows[0].name).toBe("Prog A1");
  });

  it("a member reads the exercises of their own program", async () => {
    const exercises = await withTenantContext(
      member(seed.gymA, seed.memberA1),
      async (c) =>
        (
          await c.query(
            `select name, sets, reps, rest, notes
               from exercise where program_id = $1 order by position asc`,
            [seed.progA1],
          )
        ).rows,
    );
    expect(exercises).toEqual([
      { name: "Squat", sets: 5, reps: "5", rest: "120s", notes: "brace" },
    ]);
  });

  it("a member cannot read another member's program in the same gym", async () => {
    // Even crafting the other member's id as a filter returns nothing — the
    // assignment_member_select policy scopes to app_current_member().
    const crafted = await assignedPrograms(
      member(seed.gymA, seed.memberA1),
      seed.memberA2,
    );
    expect(crafted).toHaveLength(0);

    // And the program row itself is invisible when fetched directly by id.
    const direct = await withTenantContext(
      member(seed.gymA, seed.memberA1),
      async (c) =>
        (await c.query("select id from program where id = $1", [seed.progA2]))
          .rows,
    );
    expect(direct).toHaveLength(0);
  });

  it("a member cannot read another gym's program (cross-tenant)", async () => {
    const direct = await withTenantContext(
      member(seed.gymA, seed.memberA1),
      async (c) =>
        (await c.query("select id from program where id = $1", [seed.progB]))
          .rows,
    );
    expect(direct).toHaveLength(0);

    const exercises = await withTenantContext(
      member(seed.gymA, seed.memberA1),
      async (c) =>
        (
          await c.query("select id from exercise where program_id = $1", [
            seed.progB,
          ])
        ).rows,
    );
    expect(exercises).toHaveLength(0);
  });

  it("a member with no assignment gets an empty result (empty state)", async () => {
    const rows = await assignedPrograms(
      member(seed.gymA, seed.memberA3),
      seed.memberA3,
    );
    expect(rows).toHaveLength(0);
  });
});
