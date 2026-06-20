import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import {
  closePool,
  withAdminContext,
  withTenantContext,
  type Identity,
} from "../lib/db";

/**
 * Program authoring + assignment isolation tests (mvp-program-001/003).
 *
 * Exercises the staff write paths through `withTenantContext` (as the RLS-bound
 * app_user) to prove the data-layer acceptance criteria at the DB level:
 *   - a program + ordered exercises persist and reload with order/fields exact;
 *   - programs/exercises in gym A are invisible and unwritable from gym B;
 *   - an assignment cannot link a program to a member in another tenant.
 *
 * Requires a real PostgreSQL 16 instance (provided in CI via DATABASE_URL).
 * Skipped locally with a notice when DATABASE_URL is absent.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn(
    "[programs-rls.test] DATABASE_URL not set — skipping (runs in CI).",
  );
}

type Seed = {
  gymA: string;
  gymB: string;
  memberA: string;
  memberB: string;
};

const seed = {} as Seed;
const staff = (tenantId: string): Identity => ({ tenantId, role: "staff" });

describe.skipIf(!hasDb)("program authoring & assignment isolation", () => {
  beforeAll(async () => {
    await runMigrations();
    await withAdminContext(async (c) => {
      const gymA = (
        await c.query("insert into gym (name) values ('Prog Gym A') returning id")
      ).rows[0].id as string;
      const gymB = (
        await c.query("insert into gym (name) values ('Prog Gym B') returning id")
      ).rows[0].id as string;
      const memberA = (
        await c.query(
          "insert into member (tenant_id, full_name) values ($1, 'Mem A') returning id",
          [gymA],
        )
      ).rows[0].id as string;
      const memberB = (
        await c.query(
          "insert into member (tenant_id, full_name) values ($1, 'Mem B') returning id",
          [gymB],
        )
      ).rows[0].id as string;
      Object.assign(seed, { gymA, gymB, memberA, memberB });
    });
  });

  afterAll(async () => {
    await closePool();
  });

  it("a program with ordered exercises persists and reloads with order + fields exact", async () => {
    const programId = await withTenantContext(staff(seed.gymA), async (c) => {
      const id = (
        await c.query<{ id: string }>(
          "insert into program (tenant_id, name) values ($1, 'Persist Test') returning id",
          [seed.gymA],
        )
      ).rows[0].id;
      const rows = [
        ["Deadlift", 3, "5", "180s", "brace"],
        ["Row", 4, "10", "60s", null],
        ["Curl", null, "12-15", null, "slow eccentric"],
      ] as const;
      for (let i = 0; i < rows.length; i++) {
        const [name, sets, reps, rest, notes] = rows[i];
        await c.query(
          `insert into exercise (tenant_id, program_id, position, name, sets, reps, rest, notes)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [seed.gymA, id, i, name, sets, reps, rest, notes],
        );
      }
      return id;
    });

    const exercises = await withTenantContext(staff(seed.gymA), async (c) =>
      (
        await c.query(
          `select position, name, sets, reps, rest, notes
             from exercise where program_id = $1 order by position asc`,
          [programId],
        )
      ).rows,
    );

    expect(exercises).toEqual([
      { position: 0, name: "Deadlift", sets: 3, reps: "5", rest: "180s", notes: "brace" },
      { position: 1, name: "Row", sets: 4, reps: "10", rest: "60s", notes: null },
      { position: 2, name: "Curl", sets: null, reps: "12-15", rest: null, notes: "slow eccentric" },
    ]);
  });

  it("gym B cannot see or write gym A's program", async () => {
    const programId = await withTenantContext(staff(seed.gymA), async (c) =>
      (
        await c.query<{ id: string }>(
          "insert into program (tenant_id, name) values ($1, 'A Only') returning id",
          [seed.gymA],
        )
      ).rows[0].id,
    );

    // Invisible from gym B.
    const visible = await withTenantContext(staff(seed.gymB), async (c) =>
      (await c.query("select id from program where id = $1", [programId])).rows,
    );
    expect(visible).toHaveLength(0);

    // Unwritable from gym B (cross-tenant update affects 0 rows).
    const rowCount = await withTenantContext(staff(seed.gymB), async (c) =>
      (
        await c.query("update program set name = 'hacked' where id = $1", [
          programId,
        ])
      ).rowCount,
    );
    expect(rowCount).toBe(0);
  });

  it("cannot assign gym A's program to a member in gym B", async () => {
    const programId = await withTenantContext(staff(seed.gymA), async (c) =>
      (
        await c.query<{ id: string }>(
          "insert into program (tenant_id, name) values ($1, 'Assign Test') returning id",
          [seed.gymA],
        )
      ).rows[0].id,
    );

    // The composite (member_id, tenant_id) FK with-check blocks linking a
    // gym-A-tenant assignment row to a member that lives in gym B.
    await expect(
      withTenantContext(staff(seed.gymA), async (c) => {
        await c.query(
          "insert into program_assignment (tenant_id, program_id, member_id) values ($1,$2,$3)",
          [seed.gymA, programId, seed.memberB],
        );
      }),
    ).rejects.toThrow();

    // Sanity: assigning to a same-tenant member succeeds.
    const ok = await withTenantContext(staff(seed.gymA), async (c) =>
      (
        await c.query<{ id: string }>(
          "insert into program_assignment (tenant_id, program_id, member_id) values ($1,$2,$3) returning id",
          [seed.gymA, programId, seed.memberA],
        )
      ).rows[0].id,
    );
    expect(ok).toBeTruthy();
  });
});
