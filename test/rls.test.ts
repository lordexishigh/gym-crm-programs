import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import {
  closePool,
  withAdminContext,
  withTenantContext,
  type Identity,
} from "../lib/db";

/**
 * RLS isolation smoke tests (subtask mvp-platform-foundation-005).
 *
 * These require a real PostgreSQL 16 instance. CI provides one via the
 * `postgres:16` service and sets DATABASE_URL. Locally they are skipped with a
 * notice if DATABASE_URL is absent. They assert the central security guarantee:
 * cross-tenant and cross-member access is blocked at the DB layer.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn(
    "[rls.test] DATABASE_URL not set — skipping RLS DB tests (they run in CI).",
  );
}

type Seed = {
  gymA: string;
  gymB: string;
  memberA1: string;
  memberA2: string;
  programA1: string; // assigned to memberA1
};

const seed = {} as Seed;

const staff = (tenantId: string): Identity => ({ tenantId, role: "staff" });
const member = (tenantId: string, memberId: string): Identity => ({
  tenantId,
  role: "member",
  memberId,
});

describe.skipIf(!hasDb)("RLS tenant & member isolation", () => {
  beforeAll(async () => {
    // Ensure the schema/policies exist (idempotent).
    await runMigrations();

    // Seed two independent gyms via the privileged admin path (bypasses RLS).
    await withAdminContext(async (c) => {
      const gymA = (
        await c.query("insert into gym (name) values ('Gym A') returning id")
      ).rows[0].id as string;
      const gymB = (
        await c.query("insert into gym (name) values ('Gym B') returning id")
      ).rows[0].id as string;

      const memberA1 = (
        await c.query(
          "insert into member (tenant_id, full_name) values ($1, 'Alice') returning id",
          [gymA],
        )
      ).rows[0].id as string;
      const memberA2 = (
        await c.query(
          "insert into member (tenant_id, full_name) values ($1, 'Bob') returning id",
          [gymA],
        )
      ).rows[0].id as string;
      // A member in gym B (used implicitly via cross-tenant checks).
      await c.query(
        "insert into member (tenant_id, full_name) values ($1, 'Carol')",
        [gymB],
      );

      const programA1 = (
        await c.query(
          "insert into program (tenant_id, name) values ($1, 'Strength A1') returning id",
          [gymA],
        )
      ).rows[0].id as string;
      await c.query(
        "insert into exercise (tenant_id, program_id, position, name, sets, reps, rest, notes) values ($1,$2,0,'Squat',5,'5','120s','keep back neutral')",
        [gymA, programA1],
      );
      // Assign program A1 to member A1 only.
      await c.query(
        "insert into program_assignment (tenant_id, program_id, member_id) values ($1,$2,$3)",
        [gymA, programA1, memberA1],
      );

      Object.assign(seed, { gymA, gymB, memberA1, memberA2, programA1 });
    });
  });

  afterAll(async () => {
    await closePool();
  });

  // --- Cross-tenant read ----------------------------------------------------
  it("staff in gym A see only gym A members (cannot read gym B rows)", async () => {
    const rows = await withTenantContext(staff(seed.gymA), async (c) =>
      (await c.query("select tenant_id from member")).rows,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenant_id === seed.gymA)).toBe(true);
  });

  it("a cross-tenant read of gym B's program from gym A returns nothing", async () => {
    const rows = await withTenantContext(staff(seed.gymB), async (c) =>
      (await c.query("select id from program where tenant_id = $1", [seed.gymA]))
        .rows,
    );
    expect(rows).toHaveLength(0);
  });

  // --- Cross-tenant write ---------------------------------------------------
  it("staff in gym A cannot INSERT a row into gym B (WITH CHECK blocks it)", async () => {
    await expect(
      withTenantContext(staff(seed.gymA), async (c) => {
        await c.query(
          "insert into member (tenant_id, full_name) values ($1, 'Mallory')",
          [seed.gymB],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("staff in gym A cannot UPDATE gym B's rows (0 rows affected)", async () => {
    const rowCount = await withTenantContext(staff(seed.gymA), async (c) => {
      const res = await c.query(
        "update member set full_name = 'hacked' where tenant_id = $1",
        [seed.gymB],
      );
      return res.rowCount;
    });
    expect(rowCount).toBe(0);
  });

  // --- Cross-member read ----------------------------------------------------
  it("member A1 reads only their own member row", async () => {
    const rows = await withTenantContext(
      member(seed.gymA, seed.memberA1),
      async (c) => (await c.query("select id from member")).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(seed.memberA1);
  });

  it("member A1 can read the program assigned to them", async () => {
    const rows = await withTenantContext(
      member(seed.gymA, seed.memberA1),
      async (c) => (await c.query("select id from program")).rows,
    );
    expect(rows.map((r) => r.id)).toEqual([seed.programA1]);
  });

  it("member A2 cannot read another member's assigned program", async () => {
    const programs = await withTenantContext(
      member(seed.gymA, seed.memberA2),
      async (c) => (await c.query("select id from program")).rows,
    );
    expect(programs).toHaveLength(0);
  });

  it("member A2 cannot read another member's assignment row", async () => {
    const assignments = await withTenantContext(
      member(seed.gymA, seed.memberA2),
      async (c) =>
        (await c.query("select id from program_assignment")).rows,
    );
    expect(assignments).toHaveLength(0);
  });

  it("member A2 cannot read member A1's row", async () => {
    const rows = await withTenantContext(
      member(seed.gymA, seed.memberA2),
      async (c) =>
        (
          await c.query("select id from member where id = $1", [seed.memberA1])
        ).rows,
    );
    expect(rows).toHaveLength(0);
  });
});
