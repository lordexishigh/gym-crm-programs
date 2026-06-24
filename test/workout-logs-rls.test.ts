import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import { closePool, type Identity } from "../lib/db";
import {
  logWorkout,
  memberAdherence,
  recentWorkoutLogs,
} from "../lib/workout-logs";
import { withAdminContext } from "../lib/db";

/**
 * Workout-log isolation tests (Phase GA — ga-engagement-001).
 *
 * Drives the REAL write/read path (`logWorkout` / `recentWorkoutLogs`) under
 * member and staff identities to prove the acceptance criteria at the DB level —
 * security is RLS, not application code:
 *   - a member can log a session for their OWN assigned program and read it back;
 *   - a member cannot log against a program they were never assigned;
 *   - a member cannot log on behalf of another member;
 *   - a member reads only their own logs (same gym + cross-tenant are invisible);
 *   - staff have read-only visibility into their own gym's logs, never another's.
 *
 * Requires a real PostgreSQL 16 instance (CI provides DATABASE_URL); skipped
 * locally with a notice when absent.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn(
    "[workout-logs-rls.test] DATABASE_URL not set — skipping (runs in CI).",
  );
}

type Seed = {
  gymA: string;
  gymB: string;
  memberA1: string; // gym A, assigned progA1
  memberA2: string; // gym A, assigned progA2
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

describe.skipIf(!hasDb)("workout-log isolation", () => {
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

      const gymA = await gym("WL Gym A");
      const gymB = await gym("WL Gym B");
      const memberA1 = await mem(gymA, "A One");
      const memberA2 = await mem(gymA, "A Two");
      const memberB = await mem(gymB, "B One");
      const progA1 = await prog(gymA, "Prog A1");
      const progA2 = await prog(gymA, "Prog A2");
      const progB = await prog(gymB, "Prog B");

      await assign(gymA, progA1, memberA1);
      await assign(gymA, progA2, memberA2);
      await assign(gymB, progB, memberB);

      Object.assign(seed, {
        gymA,
        gymB,
        memberA1,
        memberA2,
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

  it("a member can log a session for their own program and read it back", async () => {
    await logWorkout(member(seed.gymA, seed.memberA1), seed.memberA1, {
      programId: seed.progA1,
      effort: 8,
      note: "felt strong",
    });

    const logs = await recentWorkoutLogs(
      member(seed.gymA, seed.memberA1),
      seed.memberA1,
    );
    expect(logs).toHaveLength(1);
    expect(logs[0].program_id).toBe(seed.progA1);
    expect(logs[0].program_name).toBe("Prog A1");
    expect(logs[0].effort).toBe(8);
    expect(logs[0].note).toBe("felt strong");
  });

  it("a member cannot log against a program they were not assigned", async () => {
    // progA2 belongs to member A2; the insert WITH CHECK requires an assignment
    // for the caller, which RLS hides — so the write is rejected.
    await expect(
      logWorkout(member(seed.gymA, seed.memberA1), seed.memberA1, {
        programId: seed.progA2,
        effort: null,
        note: null,
      }),
    ).rejects.toThrow();
  });

  it("a member cannot log on behalf of another member", async () => {
    // member_id is forced to equal app_current_member() by the insert policy.
    await expect(
      logWorkout(member(seed.gymA, seed.memberA1), seed.memberA2, {
        programId: seed.progA2,
        effort: null,
        note: null,
      }),
    ).rejects.toThrow();
  });

  it("a member cannot log against another gym's program (cross-tenant)", async () => {
    await expect(
      logWorkout(member(seed.gymA, seed.memberA1), seed.memberA1, {
        programId: seed.progB,
        effort: null,
        note: null,
      }),
    ).rejects.toThrow();
  });

  it("a member reads only their own logs, even with a crafted member id", async () => {
    // Crafting member A2's id still returns nothing: the member_select policy
    // scopes to app_current_member().
    const crafted = await recentWorkoutLogs(
      member(seed.gymA, seed.memberA1),
      seed.memberA2,
    );
    expect(crafted).toHaveLength(0);
  });

  it("staff see their own gym's logs but never another gym's", async () => {
    const own = await recentWorkoutLogs(staff(seed.gymA), seed.memberA1);
    expect(own.length).toBeGreaterThanOrEqual(1);

    // Staff in gym B cannot see gym A's member logs (cross-tenant).
    const crossTenant = await recentWorkoutLogs(staff(seed.gymB), seed.memberA1);
    expect(crossTenant).toHaveLength(0);
  });

  it("staff adherence summarises a member's own-gym sessions only", async () => {
    // memberA1 logged one session in the first test; it is recent (now()).
    const own = await memberAdherence(staff(seed.gymA), seed.memberA1);
    expect(own.totalSessions).toBeGreaterThanOrEqual(1);
    expect(own.recentSessions).toBeGreaterThanOrEqual(1);
    expect(own.lastCompletedAt).not.toBeNull();

    // A member with no logs reads as zero / never, not an error.
    const idle = await memberAdherence(staff(seed.gymA), seed.memberA2);
    expect(idle.totalSessions).toBe(0);
    expect(idle.recentSessions).toBe(0);
    expect(idle.lastCompletedAt).toBeNull();

    // Cross-tenant: gym B staff see nothing for gym A's member (RLS).
    const crossTenant = await memberAdherence(staff(seed.gymB), seed.memberA1);
    expect(crossTenant.totalSessions).toBe(0);
    expect(crossTenant.lastCompletedAt).toBeNull();
  });
});
