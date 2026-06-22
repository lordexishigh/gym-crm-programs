import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import {
  closePool,
  withAdminContext,
  withTenantContext,
  type Identity,
} from "../lib/db";

/**
 * Comprehensive cross-tenant & cross-member isolation audit
 * (beta-isolation-audit-001).
 *
 * The per-feature suites each prove isolation for the table they own, but they
 * share fixtures and only probe their own read/write path — a row that is empty
 * by coincidence rather than by policy would still pass. This suite is the
 * exhaustive, adversarial backstop:
 *
 *   - It seeds TWO fully-populated, conflicting tenants (gym A and gym B), each
 *     with rows in EVERY tenanted table, plus three members (two in A, one in
 *     B) so the cross-MEMBER axis is distinct from cross-TENANT.
 *   - For every tenanted table it asserts a gym-B staff session cannot SELECT,
 *     UPDATE, or DELETE gym A's rows, and cannot INSERT a row carrying gym A's
 *     tenant_id (forged-tenant write → blocked by the WITH CHECK / FK).
 *   - For the member axis it asserts a member reads only their own rows, cannot
 *     touch another member's data even with a crafted id, cannot read any
 *     staff-only table, cannot write the member table, and can only self-insert
 *     the one gdpr_audit_event the policy permits.
 *   - It drives policies through the real `withTenantContext` session/role path
 *     (the GUC + `app_user` role the 0002 policies read) — never a superuser
 *     connection that would bypass RLS.
 *
 * Requires a real PostgreSQL 16 instance (CI provides DATABASE_URL); skipped
 * locally with a notice when absent.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn(
    "[isolation-comprehensive.test] DATABASE_URL not set — skipping (runs in CI).",
  );
}

type Seed = {
  gymA: string;
  gymB: string;
  staffA: string;
  staffB: string;
  memberA1: string;
  memberA2: string;
  memberB1: string;
  programA: string;
  programB: string;
  exerciseA: string;
  exerciseB: string;
  assignA: string;
  assignB: string;
  inviteA: string;
  inviteB: string;
  libA: string;
  libB: string;
  templateA: string;
  templateB: string;
  tplExA: string;
  tplExB: string;
  statusEvtA: string;
  statusEvtB: string;
  gdprA: string;
  gdprB: string;
};

const seed = {} as Seed;
const staff = (tenantId: string): Identity => ({ tenantId, role: "staff" });
const member = (tenantId: string, memberId: string): Identity => ({
  tenantId,
  role: "member",
  memberId,
});

/**
 * Every tenanted table, with an accessor for a seeded gym-A row id and a no-op
 * UPDATE SET clause (the column value is unchanged; the point is that a
 * cross-tenant UPDATE matches zero rows, not what it would have set).
 */
type TableProbe = {
  name: string;
  id: () => string;
  set: string;
};

const TABLE_PROBES: TableProbe[] = [
  { name: "gym", id: () => seed.gymA, set: "name = name" },
  { name: "users", id: () => seed.staffA, set: "email = email" },
  { name: "member", id: () => seed.memberA1, set: "full_name = full_name" },
  { name: "invite", id: () => seed.inviteA, set: "email = email" },
  { name: "program", id: () => seed.programA, set: "name = name" },
  { name: "exercise", id: () => seed.exerciseA, set: "name = name" },
  {
    name: "program_assignment",
    id: () => seed.assignA,
    set: "status = status",
  },
  { name: "exercise_library", id: () => seed.libA, set: "name = name" },
  { name: "program_template", id: () => seed.templateA, set: "name = name" },
  { name: "template_exercise", id: () => seed.tplExA, set: "name = name" },
  {
    name: "member_status_event",
    id: () => seed.statusEvtA,
    set: "new_status = new_status",
  },
  { name: "gdpr_audit_event", id: () => seed.gdprA, set: "action = action" },
];

/** Forged-tenant INSERT attempts: gym-B staff writing a row tagged gym A. */
type ForgedInsert = {
  name: string;
  sql: () => { text: string; values: unknown[] };
};

const FORGED_INSERTS: ForgedInsert[] = [
  {
    name: "users",
    sql: () => ({
      text: "insert into users (tenant_id, email) values ($1, 'forge@x.test')",
      values: [seed.gymA],
    }),
  },
  {
    name: "member",
    sql: () => ({
      text: "insert into member (tenant_id, full_name) values ($1, 'Forged')",
      values: [seed.gymA],
    }),
  },
  {
    name: "invite",
    sql: () => ({
      text: "insert into invite (tenant_id, member_id, email, token_hash) values ($1, $2, 'f@x.test', 'forgedhash')",
      values: [seed.gymA, seed.memberA2],
    }),
  },
  {
    name: "program",
    sql: () => ({
      text: "insert into program (tenant_id, name) values ($1, 'Forged')",
      values: [seed.gymA],
    }),
  },
  {
    name: "exercise",
    sql: () => ({
      text: "insert into exercise (tenant_id, program_id, position, name) values ($1, $2, 0, 'Forged')",
      values: [seed.gymA, seed.programA],
    }),
  },
  {
    name: "program_assignment",
    sql: () => ({
      text: "insert into program_assignment (tenant_id, program_id, member_id) values ($1, $2, $3)",
      values: [seed.gymA, seed.programA, seed.memberA2],
    }),
  },
  {
    name: "exercise_library",
    sql: () => ({
      text: "insert into exercise_library (tenant_id, name) values ($1, 'Forged')",
      values: [seed.gymA],
    }),
  },
  {
    name: "program_template",
    sql: () => ({
      text: "insert into program_template (tenant_id, name) values ($1, 'Forged')",
      values: [seed.gymA],
    }),
  },
  {
    name: "template_exercise",
    sql: () => ({
      text: "insert into template_exercise (tenant_id, template_id, position, name) values ($1, $2, 0, 'Forged')",
      values: [seed.gymA, seed.templateA],
    }),
  },
  {
    name: "member_status_event",
    sql: () => ({
      text: "insert into member_status_event (tenant_id, member_id, new_status) values ($1, $2, 'active')",
      values: [seed.gymA, seed.memberA1],
    }),
  },
  {
    name: "gdpr_audit_event",
    sql: () => ({
      text: "insert into gdpr_audit_event (tenant_id, action, actor_role) values ($1, 'export', 'staff')",
      values: [seed.gymA],
    }),
  },
];

/** Staff-only tables a member session must never be able to read. */
const STAFF_ONLY_TABLES = [
  "users",
  "invite",
  "member_status_event",
  "exercise_library",
  "program_template",
  "template_exercise",
  "gdpr_audit_event",
] as const;

describe.skipIf(!hasDb)("comprehensive cross-tenant & cross-member isolation", () => {
  beforeAll(async () => {
    await runMigrations();

    await withAdminContext(async (c) => {
      const one = async (sql: string, params: unknown[] = []) =>
        (await c.query<{ id: string }>(sql, params)).rows[0].id;

      const gymA = await one("insert into gym (name) values ('Audit Gym A') returning id");
      const gymB = await one("insert into gym (name) values ('Audit Gym B') returning id");

      const staffA = await one(
        "insert into users (tenant_id, email, role) values ($1, 'owner-a@x.test', 'owner') returning id",
        [gymA],
      );
      const staffB = await one(
        "insert into users (tenant_id, email, role) values ($1, 'owner-b@x.test', 'owner') returning id",
        [gymB],
      );

      const memberA1 = await one(
        "insert into member (tenant_id, full_name, status) values ($1, 'Audit A1', 'active') returning id",
        [gymA],
      );
      const memberA2 = await one(
        "insert into member (tenant_id, full_name, status) values ($1, 'Audit A2', 'active') returning id",
        [gymA],
      );
      const memberB1 = await one(
        "insert into member (tenant_id, full_name, status) values ($1, 'Audit B1', 'active') returning id",
        [gymB],
      );

      const programA = await one(
        "insert into program (tenant_id, name) values ($1, 'Program A') returning id",
        [gymA],
      );
      const programB = await one(
        "insert into program (tenant_id, name) values ($1, 'Program B') returning id",
        [gymB],
      );
      const exerciseA = await one(
        "insert into exercise (tenant_id, program_id, position, name) values ($1, $2, 0, 'Squat A') returning id",
        [gymA, programA],
      );
      const exerciseB = await one(
        "insert into exercise (tenant_id, program_id, position, name) values ($1, $2, 0, 'Squat B') returning id",
        [gymB, programB],
      );

      // programA → memberA1 (A1 is assigned, A2 is NOT); programB → memberB1.
      const assignA = await one(
        "insert into program_assignment (tenant_id, program_id, member_id) values ($1, $2, $3) returning id",
        [gymA, programA, memberA1],
      );
      const assignB = await one(
        "insert into program_assignment (tenant_id, program_id, member_id) values ($1, $2, $3) returning id",
        [gymB, programB, memberB1],
      );

      const inviteA = await one(
        "insert into invite (tenant_id, member_id, email, token_hash) values ($1, $2, 'a2@x.test', 'hash-a') returning id",
        [gymA, memberA2],
      );
      const inviteB = await one(
        "insert into invite (tenant_id, member_id, email, token_hash) values ($1, $2, 'b1@x.test', 'hash-b') returning id",
        [gymB, memberB1],
      );

      const libA = await one(
        "insert into exercise_library (tenant_id, name) values ($1, 'Lib A') returning id",
        [gymA],
      );
      const libB = await one(
        "insert into exercise_library (tenant_id, name) values ($1, 'Lib B') returning id",
        [gymB],
      );

      const templateA = await one(
        "insert into program_template (tenant_id, name) values ($1, 'Tpl A') returning id",
        [gymA],
      );
      const templateB = await one(
        "insert into program_template (tenant_id, name) values ($1, 'Tpl B') returning id",
        [gymB],
      );
      const tplExA = await one(
        "insert into template_exercise (tenant_id, template_id, position, name) values ($1, $2, 0, 'Tpl Ex A') returning id",
        [gymA, templateA],
      );
      const tplExB = await one(
        "insert into template_exercise (tenant_id, template_id, position, name) values ($1, $2, 0, 'Tpl Ex B') returning id",
        [gymB, templateB],
      );

      const statusEvtA = await one(
        "insert into member_status_event (tenant_id, member_id, old_status, new_status) values ($1, $2, null, 'active') returning id",
        [gymA, memberA1],
      );
      const statusEvtB = await one(
        "insert into member_status_event (tenant_id, member_id, old_status, new_status) values ($1, $2, null, 'active') returning id",
        [gymB, memberB1],
      );

      const gdprA = await one(
        "insert into gdpr_audit_event (tenant_id, action, actor_role, subject_member_id) values ($1, 'export', 'staff', $2) returning id",
        [gymA, memberA1],
      );
      const gdprB = await one(
        "insert into gdpr_audit_event (tenant_id, action, actor_role, subject_member_id) values ($1, 'export', 'staff', $2) returning id",
        [gymB, memberB1],
      );

      Object.assign(seed, {
        gymA, gymB, staffA, staffB,
        memberA1, memberA2, memberB1,
        programA, programB, exerciseA, exerciseB,
        assignA, assignB, inviteA, inviteB,
        libA, libB, templateA, templateB, tplExA, tplExB,
        statusEvtA, statusEvtB, gdprA, gdprB,
      });
    });
  });

  afterAll(async () => {
    await closePool();
  });

  // --- Cross-tenant: gym B staff vs gym A's rows, every table -----------------
  describe("cross-tenant: a gym-B staff session cannot reach gym A's rows", () => {
    for (const probe of TABLE_PROBES) {
      it(`${probe.name}: SELECT by id returns nothing`, async () => {
        const rows = await withTenantContext(staff(seed.gymB), async (c) =>
          (await c.query(`select 1 from ${probe.name} where id = $1`, [probe.id()]))
            .rows,
        );
        expect(rows).toHaveLength(0);
      });

      it(`${probe.name}: UPDATE by id affects 0 rows`, async () => {
        const rowCount = await withTenantContext(staff(seed.gymB), async (c) =>
          (
            await c.query(
              `update ${probe.name} set ${probe.set} where id = $1`,
              [probe.id()],
            )
          ).rowCount,
        );
        expect(rowCount).toBe(0);
      });

      it(`${probe.name}: DELETE by id affects 0 rows`, async () => {
        const rowCount = await withTenantContext(staff(seed.gymB), async (c) =>
          (await c.query(`delete from ${probe.name} where id = $1`, [probe.id()]))
            .rowCount,
        );
        expect(rowCount).toBe(0);
      });
    }
  });

  // --- Forged-tenant writes: gym B staff inserting a gym-A-tagged row ---------
  describe("forged-tenant INSERT (gym B staff tagging a row with gym A) is blocked", () => {
    for (const f of FORGED_INSERTS) {
      it(`${f.name}: rejected by RLS WITH CHECK / FK`, async () => {
        const { text, values } = f.sql();
        await expect(
          withTenantContext(staff(seed.gymB), async (c) => {
            await c.query(text, values);
          }),
        ).rejects.toThrow();
      });
    }

    it("gym is not insertable even within the caller's own tenant (admin-only)", async () => {
      await expect(
        withTenantContext(staff(seed.gymB), async (c) => {
          await c.query("insert into gym (name) values ('Self-serve gym')");
        }),
      ).rejects.toThrow();
    });

    it("positive control: gym B staff CAN write within their own tenant", async () => {
      // Proves the denials above are tenant-specific, not a blanket failure.
      const rowCount = await withTenantContext(staff(seed.gymB), async (c) => {
        const res = await c.query(
          "insert into exercise_library (tenant_id, name) values ($1, 'Own-tenant OK')",
          [seed.gymB],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
    });
  });

  // --- Member axis: own rows only --------------------------------------------
  describe("member sees only their own rows", () => {
    it("a member reads only their own member row", async () => {
      const rows = await withTenantContext(
        member(seed.gymA, seed.memberA1),
        async (c) => (await c.query("select id from member")).rows,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(seed.memberA1);
    });

    it("a member cannot read another member's row (crafted id)", async () => {
      const rows = await withTenantContext(
        member(seed.gymA, seed.memberA2),
        async (c) =>
          (await c.query("select id from member where id = $1", [seed.memberA1]))
            .rows,
      );
      expect(rows).toHaveLength(0);
    });

    it("a member reads only their own assigned program + exercises", async () => {
      const { programs, exercises } = await withTenantContext(
        member(seed.gymA, seed.memberA1),
        async (c) => ({
          programs: (await c.query("select id from program")).rows,
          exercises: (await c.query("select id from exercise")).rows,
        }),
      );
      expect(programs.map((r) => r.id)).toEqual([seed.programA]);
      expect(exercises.map((r) => r.id)).toEqual([seed.exerciseA]);
    });

    it("an unassigned member sees no program / exercise / assignment", async () => {
      const counts = await withTenantContext(
        member(seed.gymA, seed.memberA2),
        async (c) => ({
          programs: (await c.query("select id from program")).rowCount,
          exercises: (await c.query("select id from exercise")).rowCount,
          assignments: (await c.query("select id from program_assignment")).rowCount,
        }),
      );
      expect(counts).toEqual({ programs: 0, exercises: 0, assignments: 0 });
    });

    it("a member reads only their own assignment row", async () => {
      const rows = await withTenantContext(
        member(seed.gymA, seed.memberA1),
        async (c) => (await c.query("select id from program_assignment")).rows,
      );
      expect(rows.map((r) => r.id)).toEqual([seed.assignA]);
    });
  });

  // --- Member axis: staff-only tables are invisible --------------------------
  describe("member cannot read any staff-only table", () => {
    for (const table of STAFF_ONLY_TABLES) {
      it(`${table}: returns no rows under a member session`, async () => {
        const rowCount = await withTenantContext(
          member(seed.gymA, seed.memberA1),
          async (c) => (await c.query(`select 1 from ${table}`)).rowCount,
        );
        expect(rowCount).toBe(0);
      });
    }
  });

  // --- Member axis: the member table is read-only to a member ----------------
  describe("member cannot write the member table", () => {
    it("UPDATE of own row affects 0 rows (no member UPDATE policy)", async () => {
      const rowCount = await withTenantContext(
        member(seed.gymA, seed.memberA1),
        async (c) =>
          (
            await c.query("update member set full_name = 'self-edit' where id = $1", [
              seed.memberA1,
            ])
          ).rowCount,
      );
      expect(rowCount).toBe(0);
    });

    it("INSERT of a new member is rejected", async () => {
      await expect(
        withTenantContext(member(seed.gymA, seed.memberA1), async (c) => {
          await c.query(
            "insert into member (tenant_id, full_name) values ($1, 'Member-made')",
            [seed.gymA],
          );
        }),
      ).rejects.toThrow();
    });

    it("DELETE of own row affects 0 rows", async () => {
      const rowCount = await withTenantContext(
        member(seed.gymA, seed.memberA1),
        async (c) =>
          (await c.query("delete from member where id = $1", [seed.memberA1]))
            .rowCount,
      );
      expect(rowCount).toBe(0);
    });
  });

  // --- Member axis: the single permitted gdpr_audit_event self-insert --------
  describe("member gdpr_audit_event writes are constrained to a self-export", () => {
    it("allows a self-export event for the member themselves", async () => {
      const rowCount = await withTenantContext(
        member(seed.gymA, seed.memberA1),
        async (c) =>
          (
            await c.query(
              "insert into gdpr_audit_event (tenant_id, action, actor_role, subject_member_id) values ($1, 'export', 'member', $2)",
              [seed.gymA, seed.memberA1],
            )
          ).rowCount,
      );
      expect(rowCount).toBe(1);
    });

    it("rejects an event whose subject is ANOTHER member", async () => {
      await expect(
        withTenantContext(member(seed.gymA, seed.memberA1), async (c) => {
          await c.query(
            "insert into gdpr_audit_event (tenant_id, action, actor_role, subject_member_id) values ($1, 'export', 'member', $2)",
            [seed.gymA, seed.memberA2],
          );
        }),
      ).rejects.toThrow();
    });

    it("rejects an 'erasure' action (only 'export' is self-serviceable)", async () => {
      await expect(
        withTenantContext(member(seed.gymA, seed.memberA1), async (c) => {
          await c.query(
            "insert into gdpr_audit_event (tenant_id, action, actor_role, subject_member_id) values ($1, 'erasure', 'member', $2)",
            [seed.gymA, seed.memberA1],
          );
        }),
      ).rejects.toThrow();
    });

    it("rejects attaching a staff subject to a member's event", async () => {
      await expect(
        withTenantContext(member(seed.gymA, seed.memberA1), async (c) => {
          await c.query(
            "insert into gdpr_audit_event (tenant_id, action, actor_role, subject_member_id, subject_user_id) values ($1, 'export', 'member', $2, $3)",
            [seed.gymA, seed.memberA1, seed.staffA],
          );
        }),
      ).rejects.toThrow();
    });
  });

  // --- Member axis: cross-tenant and forged-identity members -----------------
  describe("member cannot cross tenants, even with a forged identity", () => {
    it("a gym-B member cannot read gym A's member/program rows", async () => {
      const counts = await withTenantContext(
        member(seed.gymB, seed.memberB1),
        async (c) => ({
          member: (
            await c.query("select 1 from member where id = $1", [seed.memberA1])
          ).rowCount,
          program: (
            await c.query("select 1 from program where id = $1", [seed.programA])
          ).rowCount,
        }),
      );
      expect(counts).toEqual({ member: 0, program: 0 });
    });

    it("a member_id that doesn't belong to the claimed tenant resolves to nothing", async () => {
      // Forged identity: tenant gym A, but member id belongs to gym B. The member
      // policy requires id = app_current_member() AND tenant_id = app_current_tenant(),
      // so the mismatched pair matches no row.
      const rows = await withTenantContext(
        member(seed.gymA, seed.memberB1),
        async (c) => (await c.query("select id from member")).rows,
      );
      expect(rows).toHaveLength(0);
    });
  });
});
