import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import {
  closePool,
  withAdminContext,
  withTenantContext,
  type Identity,
} from "../lib/db";
import { exportMemberData, exportStaffData } from "../lib/gdpr/export";

/**
 * GDPR export tests (beta-gdpr-001).
 *
 * Like rls.test.ts these require a real PostgreSQL 16 instance (CI provides one;
 * locally they skip when DATABASE_URL is absent). They assert the acceptance
 * criteria directly: a subject's data can be exported, the export contains ONLY
 * that subject's data (isolation enforced by RLS, not query text), cross-tenant
 * ids resolve to nothing, and every export is logged for audit.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn(
    "[gdpr-export.test] DATABASE_URL not set — skipping (runs in CI).",
  );
}

type Seed = {
  gymA: string;
  gymB: string;
  memberA1: string; // has program PA1 assigned
  memberA2: string; // has a different program
  staffA: string; // users.id in gym A
  programA1: string;
  programA2: string;
};

const seed = {} as Seed;

const staff = (tenantId: string): Identity => ({ tenantId, role: "staff" });
const member = (tenantId: string, memberId: string): Identity => ({
  tenantId,
  role: "member",
  memberId,
});

describe.skipIf(!hasDb)("GDPR export — scope & audit", () => {
  beforeAll(async () => {
    await runMigrations();

    await withAdminContext(async (c) => {
      const gymA = (
        await c.query("insert into gym (name) values ('Export Gym A') returning id")
      ).rows[0].id as string;
      const gymB = (
        await c.query("insert into gym (name) values ('Export Gym B') returning id")
      ).rows[0].id as string;

      const staffA = (
        await c.query(
          "insert into users (tenant_id, email, full_name) values ($1, 'trainer@a.example', 'Trainer A') returning id",
          [gymA],
        )
      ).rows[0].id as string;

      const memberA1 = (
        await c.query(
          "insert into member (tenant_id, full_name, email, phone, notes) values ($1, 'Alice', 'alice@a.example', '+357 99 000111', 'VIP') returning id",
          [gymA],
        )
      ).rows[0].id as string;
      const memberA2 = (
        await c.query(
          "insert into member (tenant_id, full_name, email) values ($1, 'Bob', 'bob@a.example') returning id",
          [gymA],
        )
      ).rows[0].id as string;

      const programA1 = (
        await c.query(
          "insert into program (tenant_id, name) values ($1, 'A1 program') returning id",
          [gymA],
        )
      ).rows[0].id as string;
      const programA2 = (
        await c.query(
          "insert into program (tenant_id, name) values ($1, 'A2 program') returning id",
          [gymA],
        )
      ).rows[0].id as string;
      await c.query(
        "insert into exercise (tenant_id, program_id, position, name) values ($1,$2,0,'Squat')",
        [gymA, programA1],
      );
      await c.query(
        "insert into program_assignment (tenant_id, program_id, member_id) values ($1,$2,$3)",
        [gymA, programA1, memberA1],
      );
      await c.query(
        "insert into program_assignment (tenant_id, program_id, member_id) values ($1,$2,$3)",
        [gymA, programA2, memberA2],
      );
      // An invite for member A1 (staff export should include it).
      await c.query(
        "insert into invite (tenant_id, member_id, email, token_hash) values ($1,$2,'alice@a.example','hash-a1')",
        [gymA, memberA1],
      );
      // A logged workout for member A1 (export should include it; Phase GA).
      await c.query(
        "insert into workout_log (tenant_id, member_id, program_id, effort, note) values ($1,$2,$3,7,'leg day')",
        [gymA, memberA1, programA1],
      );

      Object.assign(seed, {
        gymA,
        gymB,
        memberA1,
        memberA2,
        staffA,
        programA1,
        programA2,
      });
    });
  });

  afterAll(async () => {
    await closePool();
  });

  it("staff can export a member, and only that member's data", async () => {
    const { data } = await exportMemberData(staff(seed.gymA), seed.memberA1);
    expect(data).not.toBeNull();
    expect(data!.subject).toEqual({ type: "member", id: seed.memberA1 });
    expect(data!.member.full_name).toBe("Alice");
    expect(data!.member.email).toBe("alice@a.example");
    // Only A1's program — never A2's.
    expect(data!.programs.map((p) => p.program.id)).toEqual([seed.programA1]);
    expect(data!.programs[0].exercises.map((e) => e.name)).toEqual(["Squat"]);
    expect(data!.invites.map((i) => i.email)).toEqual(["alice@a.example"]);
    // Workout logs are part of the member's exported data (Phase GA).
    expect(data!.workout_logs).toHaveLength(1);
    expect(data!.workout_logs[0]).toMatchObject({
      program_id: seed.programA1,
      program_name: "A1 program",
      effort: 7,
      note: "leg day",
    });
  });

  it("a cross-tenant export resolves to nothing (RLS isolation)", async () => {
    const { data } = await exportMemberData(staff(seed.gymB), seed.memberA1);
    expect(data).toBeNull();
  });

  it("a member self-export sees their own profile + programs only", async () => {
    const { data } = await exportMemberData(
      member(seed.gymA, seed.memberA1),
      seed.memberA1,
    );
    expect(data).not.toBeNull();
    expect(data!.member.id).toBe(seed.memberA1);
    expect(data!.programs.map((p) => p.program.id)).toEqual([seed.programA1]);
    // The member's own workout logs ARE part of a self-export.
    expect(data!.workout_logs).toHaveLength(1);
    // Staff-internal records are not exposed to a member self-export.
    expect(data!.invites).toHaveLength(0);
    expect(data!.status_history).toHaveLength(0);
  });

  it("a member cannot export another member (RLS hides the row)", async () => {
    const { data } = await exportMemberData(
      member(seed.gymA, seed.memberA1),
      seed.memberA2,
    );
    expect(data).toBeNull();
  });

  it("staff can export a staff data subject with an activity summary", async () => {
    const { data } = await exportStaffData(staff(seed.gymA), seed.staffA);
    expect(data).not.toBeNull();
    expect(data!.subject).toEqual({ type: "staff", id: seed.staffA });
    expect(data!.staff.email).toBe("trainer@a.example");
    expect(data!.activity).toMatchObject({
      programs_created: expect.any(Number),
      assignments_made: expect.any(Number),
      invites_created: expect.any(Number),
      status_changes_made: expect.any(Number),
    });
  });

  it("every export is logged to the audit trail", async () => {
    // Trigger fresh exports, then count the audit rows for each subject.
    await exportMemberData(staff(seed.gymA), seed.memberA1);
    await exportStaffData(staff(seed.gymA), seed.staffA);

    const counts = await withTenantContext(staff(seed.gymA), async (c) => {
      const memberRows = await c.query(
        "select count(*)::int as n from gdpr_audit_event where action = 'export' and subject_member_id = $1",
        [seed.memberA1],
      );
      const staffRows = await c.query(
        "select count(*)::int as n from gdpr_audit_event where action = 'export' and subject_user_id = $1",
        [seed.staffA],
      );
      return {
        member: memberRows.rows[0].n as number,
        staff: staffRows.rows[0].n as number,
      };
    });

    expect(counts.member).toBeGreaterThan(0);
    expect(counts.staff).toBeGreaterThan(0);
  });

  it("a member self-export writes its own audit row (member INSERT policy)", async () => {
    await exportMemberData(member(seed.gymA, seed.memberA2), seed.memberA2);
    const n = await withTenantContext(staff(seed.gymA), async (c) =>
      (
        await c.query(
          "select count(*)::int as n from gdpr_audit_event where actor_role = 'member' and subject_member_id = $1",
          [seed.memberA2],
        )
      ).rows[0].n as number,
    );
    expect(n).toBeGreaterThan(0);
  });
});
