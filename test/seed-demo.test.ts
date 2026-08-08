import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { runMigrations } from "../scripts/migrate.mjs";
import { DEMO_PLANS, DEMO_PROGRAM, seedDemoWalkthrough } from "../scripts/seed.mjs";
import { closePool, withAdminContext } from "../lib/db";

/**
 * Demo-walkthrough seed tests.
 *
 * The seed is the ONLY way into a fresh install (no public signup), and its SQL
 * is tightly coupled to constraints spread across eight migrations — a partial
 * unique index allowing one ACTIVE assignment per member (0011), composite
 * (id, tenant_id) FK targets (0014), and the deliberate absence of a unique key
 * on member (tenant_id, email). A wrong assumption there does not fail loudly at
 * review time; it fails when someone runs `npm run seed` on a clean database and
 * cannot get in at all. These tests run the real SQL against a real Postgres.
 *
 * Idempotency is asserted by seeding TWICE: the script is invoked on every boot
 * path and by operators re-running it, so a second run must converge on the same
 * state rather than duplicating rows or tripping a unique index.
 *
 * The Supabase Auth calls are the one part that cannot run here (no project to
 * talk to), so a stub provisioner supplies auth-user ids — the injection seam
 * `seedDemoWalkthrough` exposes for exactly this. Everything else is real.
 *
 * Requires a real PostgreSQL 16 instance (provided in CI via DATABASE_URL).
 * Skipped locally with a notice when DATABASE_URL is absent.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn("[seed-demo.test] DATABASE_URL not set — skipping (runs in CI).");
}

/** Stand-in for the Supabase admin API: a stable id per email, as the real one gives. */
function makeStubProvisioner() {
  const issued = new Map<string, string>();
  const calls: { email: string; appMetadata: Record<string, unknown> }[] = [];
  const provision = async ({
    email,
    appMetadata,
  }: {
    email: string;
    password: string;
    appMetadata: Record<string, unknown>;
  }) => {
    calls.push({ email, appMetadata });
    if (!issued.has(email)) issued.set(email, randomUUID());
    return issued.get(email)!;
  };
  return { provision, calls };
}

describe.skipIf(!hasDb)("seedDemoWalkthrough", () => {
  let tenantId: string;
  let result: Awaited<ReturnType<typeof seedDemoWalkthrough>>;
  let stub: ReturnType<typeof makeStubProvisioner>;

  beforeAll(async () => {
    await runMigrations();
    stub = makeStubProvisioner();
    await withAdminContext(async (c) => {
      tenantId = (
        await c.query("insert into gym (name) values ('Seed Demo Gym') returning id")
      ).rows[0].id as string;
      // Seed twice with the SAME provisioner — the idempotency check.
      await seedDemoWalkthrough(c, tenantId, stub.provision);
      result = await seedDemoWalkthrough(c, tenantId, stub.provision);
    });
  }, 120_000);

  afterAll(async () => {
    if (tenantId) {
      // Cascades to every seeded row (all FKs are ON DELETE CASCADE to gym).
      await withAdminContext((c) =>
        c.query("delete from gym where id = $1", [tenantId]),
      );
    }
    await closePool();
  });

  it("creates the trainer as staff with the trainer role, not owner", async () => {
    await withAdminContext(async (c) => {
      const { rows } = await c.query(
        "select role, email, auth_user_id from users where id = $1 and tenant_id = $2",
        [result.trainerId, tenantId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe("trainer");
      expect(rows[0].email).toBe(result.trainerEmail);
      // Linked to an auth user, or the account cannot sign in.
      expect(rows[0].auth_user_id).toBeTruthy();
    });
  });

  it("creates the member with the safety and membership-status fields populated", async () => {
    await withAdminContext(async (c) => {
      const { rows } = await c.query(
        `select full_name, phone, status, membership_status, emergency_contact_name,
                emergency_contact_phone, auth_user_id
           from member where id = $1 and tenant_id = $2`,
        [result.memberId, tenantId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("active");
      expect(rows[0].membership_status).toBe("active");
      expect(rows[0].emergency_contact_name).toBeTruthy();
      expect(rows[0].emergency_contact_phone).toBeTruthy();
      expect(rows[0].phone).toBeTruthy();
      // The row must be linked back to the auth user created for it.
      expect(rows[0].auth_user_id).toBeTruthy();
    });
  });

  it("gives the member auth user a member_id claim matching its row", async () => {
    // requireMember() bounces a member session with no member_id straight back
    // to the portal login, so this claim is what makes the portal reachable.
    const memberCall = stub.calls.find((c) => c.email === result.memberEmail);
    expect(memberCall).toBeDefined();
    expect(memberCall!.appMetadata.app_role).toBe("member");
    expect(memberCall!.appMetadata.tenant_id).toBe(tenantId);
    expect(memberCall!.appMetadata.member_id).toBe(result.memberId);
  });

  it("creates the program with its exercises in order, authored by the trainer", async () => {
    await withAdminContext(async (c) => {
      const program = await c.query(
        "select name, created_by from program where id = $1 and tenant_id = $2",
        [result.programId, tenantId],
      );
      expect(program.rows).toHaveLength(1);
      expect(program.rows[0].name).toBe(DEMO_PROGRAM.name);
      expect(program.rows[0].created_by).toBe(result.trainerId);

      const exercises = await c.query(
        `select name, sets, reps, position from exercise
           where program_id = $1 and tenant_id = $2 order by position`,
        [result.programId, tenantId],
      );
      // Re-seeding must REPLACE the exercises, not append a second copy.
      expect(exercises.rows).toHaveLength(DEMO_PROGRAM.exercises.length);
      expect(exercises.rows.map((r) => r.name)).toEqual(
        DEMO_PROGRAM.exercises.map((e) => e.name),
      );
      expect(exercises.rows.map((r) => r.position)).toEqual([0, 1, 2]);
    });
  });

  it("assigns the program to the member with exactly one active assignment", async () => {
    await withAdminContext(async (c) => {
      const { rows } = await c.query(
        `select program_id, assigned_by, status from program_assignment
           where tenant_id = $1 and member_id = $2 and status = 'active'`,
        [tenantId, result.memberId],
      );
      // uq_assignment_one_active_per_member (0011) permits only one; a second
      // seed run must not have tried to add another.
      expect(rows).toHaveLength(1);
      expect(rows[0].program_id).toBe(result.programId);
      expect(rows[0].assigned_by).toBe(result.trainerId);
    });
  });

  it("creates one plan per billing tier and does not duplicate on re-seed", async () => {
    await withAdminContext(async (c) => {
      const { rows } = await c.query(
        "select tier, price_cents, active from membership_plans where tenant_id = $1 order by tier",
        [tenantId],
      );
      expect(rows).toHaveLength(DEMO_PLANS.length);
      expect(rows.map((r) => r.tier).sort()).toEqual(
        DEMO_PLANS.map((p) => p.tier).sort(),
      );
      expect(rows.every((r) => r.active)).toBe(true);
      expect(rows.every((r) => r.price_cents > 0)).toBe(true);
    });
  });

  it("gives the member a single active subscription against the monthly plan", async () => {
    await withAdminContext(async (c) => {
      const { rows } = await c.query(
        `select status, plan_id, current_period_end from member_plans
           where tenant_id = $1 and member_id = $2`,
        [tenantId, result.memberId],
      );
      // `seed.mjs` is untyped JS, so the tier→id map widens to `{}` here.
      const planIds = result.planIds as Record<string, string>;
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("active");
      expect(rows[0].plan_id).toBe(planIds.monthly);
      expect(new Date(rows[0].current_period_end).getTime()).toBeGreaterThan(
        Date.now(),
      );
    });
  });

  it("leaves no duplicated staff or member rows after two runs", async () => {
    await withAdminContext(async (c) => {
      const staff = await c.query(
        "select count(*)::int as n from users where tenant_id = $1 and email = $2",
        [tenantId, result.trainerEmail],
      );
      expect(staff.rows[0].n).toBe(1);
      const members = await c.query(
        "select count(*)::int as n from member where tenant_id = $1 and lower(email) = lower($2)",
        [tenantId, result.memberEmail],
      );
      expect(members.rows[0].n).toBe(1);
    });
  });
});
