import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import { closePool, withAdminContext, withTenantContext, type Identity } from "../lib/db";
import {
  completeMemberTask,
  createMemberTask,
  memberTasks,
} from "../lib/member-tasks";

/**
 * Follow-up task isolation tests (CRM-IDEAS "Apply now" #5).
 *
 * Drives the REAL write/read path under staff and member identities to prove
 * the acceptance criteria at the DB level — security is RLS
 * (`member_task_staff_all`, migration 0013), not application code:
 *   - staff can create and complete a task on their own gym's member;
 *   - staff cannot see or write another gym's tasks;
 *   - a member session cannot read or write member_task AT ALL (staff-only
 *     table — unlike workout_log, members have no self-scoped policy here).
 *
 * Requires a real PostgreSQL 16 instance (CI provides DATABASE_URL); skipped
 * locally with a notice when absent.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn(
    "[member-tasks-rls.test] DATABASE_URL not set — skipping (runs in CI).",
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
const member = (tenantId: string, memberId: string): Identity => ({
  tenantId,
  role: "member",
  memberId,
});

describe.skipIf(!hasDb)("member-task isolation", () => {
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

      const gymA = await gym("Task Gym A");
      const gymB = await gym("Task Gym B");
      const memberA = await mem(gymA, "A Member");
      const memberB = await mem(gymB, "B Member");

      Object.assign(seed, { gymA, gymB, memberA, memberB });
    });
  });

  afterAll(async () => {
    await closePool();
  });

  it("staff can create a task and read it back", async () => {
    await createMemberTask(
      staff(seed.gymA),
      seed.memberA,
      { title: "Check in about missed sessions", dueAt: null },
      null,
    );

    const tasks = await memberTasks(staff(seed.gymA), seed.memberA);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Check in about missed sessions");
    expect(tasks[0].completed_at).toBeNull();
  });

  it("staff can mark a task done, idempotently", async () => {
    const { id } = await createMemberTask(
      staff(seed.gymA),
      seed.memberA,
      { title: "Follow up", dueAt: null },
      null,
    );

    const first = await completeMemberTask(staff(seed.gymA), id);
    expect(first).toBe(1);

    // Completing an already-done task is a no-op (0 rows), not an error.
    const second = await completeMemberTask(staff(seed.gymA), id);
    expect(second).toBe(0);

    const tasks = await memberTasks(staff(seed.gymA), seed.memberA);
    const task = tasks.find((t) => t.id === id);
    expect(task?.completed_at).not.toBeNull();
  });

  it("staff cannot see or complete another gym's tasks (cross-tenant)", async () => {
    const { id } = await createMemberTask(
      staff(seed.gymB),
      seed.memberB,
      { title: "Gym B only", dueAt: null },
      null,
    );

    const crossTenant = await memberTasks(staff(seed.gymA), seed.memberB);
    expect(crossTenant).toHaveLength(0);

    const updated = await completeMemberTask(staff(seed.gymA), id);
    expect(updated).toBe(0);
  });

  it("a member session cannot read or write member_task at all", async () => {
    // member_task_staff_all is staff-only — a member session (any role check
    // fails) sees nothing and cannot write, even for their own record.
    const asMember = await memberTasks(member(seed.gymA, seed.memberA), seed.memberA);
    expect(asMember).toHaveLength(0);

    await expect(
      withTenantContext(member(seed.gymA, seed.memberA), (c) =>
        c.query(
          "insert into member_task (tenant_id, member_id, title) values ($1, $2, 'forged')",
          [seed.gymA, seed.memberA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
