import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import {
  closePool,
  withAdminContext,
  withTenantContext,
  type Identity,
} from "../lib/db";

/**
 * Exercise library + program template isolation tests
 * (alpha-exercise-library-001/002).
 *
 * Proves the data-layer acceptance criteria at the DB level through the
 * RLS-bound `app_user`:
 *   - a library exercise persists, reloads, and is invisible/unwritable cross-tenant;
 *   - a template + its ordered exercises persist and reload with order exact;
 *   - templates in gym A are invisible from gym B;
 *   - a template instantiates into a real program (copy preserves order).
 *
 * Requires a real PostgreSQL 16 instance (CI provides DATABASE_URL); skipped
 * locally with a notice when absent.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn(
    "[library-templates-rls.test] DATABASE_URL not set — skipping (runs in CI).",
  );
}

type Seed = { gymA: string; gymB: string };
const seed = {} as Seed;
const staff = (tenantId: string): Identity => ({ tenantId, role: "staff" });

describe.skipIf(!hasDb)("exercise library & template isolation", () => {
  beforeAll(async () => {
    await runMigrations();
    await withAdminContext(async (c) => {
      const gymA = (
        await c.query("insert into gym (name) values ('Lib Gym A') returning id")
      ).rows[0].id as string;
      const gymB = (
        await c.query("insert into gym (name) values ('Lib Gym B') returning id")
      ).rows[0].id as string;
      Object.assign(seed, { gymA, gymB });
    });
  });

  afterAll(async () => {
    await closePool();
  });

  it("a library exercise persists and reloads", async () => {
    const id = await withTenantContext(staff(seed.gymA), async (c) =>
      (
        await c.query<{ id: string }>(
          `insert into exercise_library (tenant_id, name, sets, reps, rest, notes)
           values ($1, 'Bench press', 5, '5', '120s', 'pause on chest') returning id`,
          [seed.gymA],
        )
      ).rows[0].id,
    );

    const row = await withTenantContext(staff(seed.gymA), async (c) =>
      (
        await c.query(
          "select name, sets, reps, rest, notes from exercise_library where id = $1",
          [id],
        )
      ).rows[0],
    );
    expect(row).toEqual({
      name: "Bench press",
      sets: 5,
      reps: "5",
      rest: "120s",
      notes: "pause on chest",
    });
  });

  it("gym B cannot see or write gym A's library exercise", async () => {
    const id = await withTenantContext(staff(seed.gymA), async (c) =>
      (
        await c.query<{ id: string }>(
          "insert into exercise_library (tenant_id, name) values ($1, 'A Only Ex') returning id",
          [seed.gymA],
        )
      ).rows[0].id,
    );

    const visible = await withTenantContext(staff(seed.gymB), async (c) =>
      (await c.query("select id from exercise_library where id = $1", [id]))
        .rows,
    );
    expect(visible).toHaveLength(0);

    const rowCount = await withTenantContext(staff(seed.gymB), async (c) =>
      (
        await c.query("delete from exercise_library where id = $1", [id])
      ).rowCount,
    );
    expect(rowCount).toBe(0);
  });

  it("a template with ordered exercises persists and reloads exact", async () => {
    const templateId = await withTenantContext(staff(seed.gymA), async (c) => {
      const tid = (
        await c.query<{ id: string }>(
          "insert into program_template (tenant_id, name, description) values ($1, 'Tpl 1', 'desc') returning id",
          [seed.gymA],
        )
      ).rows[0].id;
      const rows = [
        ["Squat", 3, "5", "180s", null],
        ["Press", 4, "8", "90s", "strict"],
      ] as const;
      for (let i = 0; i < rows.length; i++) {
        const [name, sets, reps, rest, notes] = rows[i];
        await c.query(
          `insert into template_exercise (tenant_id, template_id, position, name, sets, reps, rest, notes)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [seed.gymA, tid, i, name, sets, reps, rest, notes],
        );
      }
      return tid;
    });

    const exercises = await withTenantContext(staff(seed.gymA), async (c) =>
      (
        await c.query(
          `select position, name, sets, reps, rest, notes
             from template_exercise where template_id = $1 order by position asc`,
          [templateId],
        )
      ).rows,
    );
    expect(exercises).toEqual([
      { position: 0, name: "Squat", sets: 3, reps: "5", rest: "180s", notes: null },
      { position: 1, name: "Press", sets: 4, reps: "8", rest: "90s", notes: "strict" },
    ]);
  });

  it("gym B cannot see gym A's template", async () => {
    const templateId = await withTenantContext(staff(seed.gymA), async (c) =>
      (
        await c.query<{ id: string }>(
          "insert into program_template (tenant_id, name) values ($1, 'A Tpl') returning id",
          [seed.gymA],
        )
      ).rows[0].id,
    );

    const visible = await withTenantContext(staff(seed.gymB), async (c) =>
      (await c.query("select id from program_template where id = $1", [templateId]))
        .rows,
    );
    expect(visible).toHaveLength(0);
  });

  it("instantiating a template copies its exercises into a new program (order preserved)", async () => {
    // Build a template with two exercises.
    const templateId = await withTenantContext(staff(seed.gymA), async (c) => {
      const tid = (
        await c.query<{ id: string }>(
          "insert into program_template (tenant_id, name, description) values ($1, 'Copy Me', 'd') returning id",
          [seed.gymA],
        )
      ).rows[0].id;
      const rows = [
        ["Hinge", 3, "6", "120s", "a"],
        ["Pull", 3, "10", "60s", "b"],
      ] as const;
      for (let i = 0; i < rows.length; i++) {
        const [name, sets, reps, rest, notes] = rows[i];
        await c.query(
          `insert into template_exercise (tenant_id, template_id, position, name, sets, reps, rest, notes)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [seed.gymA, tid, i, name, sets, reps, rest, notes],
        );
      }
      return tid;
    });

    // Copy template → new program (mirrors createProgramFromTemplateAction).
    const programId = await withTenantContext(staff(seed.gymA), async (c) => {
      const tpl = (
        await c.query<{ name: string; description: string | null }>(
          "select name, description from program_template where id = $1",
          [templateId],
        )
      ).rows[0];
      const tex = (
        await c.query(
          `select name, sets, reps, rest, notes from template_exercise
             where template_id = $1 order by position asc`,
          [templateId],
        )
      ).rows;
      const pid = (
        await c.query<{ id: string }>(
          "insert into program (tenant_id, name, description) values ($1, $2, $3) returning id",
          [seed.gymA, tpl.name, tpl.description],
        )
      ).rows[0].id;
      for (let i = 0; i < tex.length; i++) {
        const e = tex[i];
        await c.query(
          `insert into exercise (tenant_id, program_id, position, name, sets, reps, rest, notes)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [seed.gymA, pid, i, e.name, e.sets, e.reps, e.rest, e.notes],
        );
      }
      return pid;
    });

    const copied = await withTenantContext(staff(seed.gymA), async (c) =>
      (
        await c.query(
          `select position, name, sets, reps, rest, notes
             from exercise where program_id = $1 order by position asc`,
          [programId],
        )
      ).rows,
    );
    expect(copied).toEqual([
      { position: 0, name: "Hinge", sets: 3, reps: "6", rest: "120s", notes: "a" },
      { position: 1, name: "Pull", sets: 3, reps: "10", rest: "60s", notes: "b" },
    ]);
  });
});
