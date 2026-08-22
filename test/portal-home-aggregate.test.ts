import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import { closePool, withAdminContext, type Identity } from "../lib/db";
import { loadPortalHome } from "../lib/portal";

/**
 * `loadPortalHome` (#32 fix) folds the 8 separate `withTenantContext` calls
 * `app/portal/page.tsx` used to make into ONE tenant transaction. This proves
 * the aggregate returns the same data each standalone query would, and that
 * combining the queries into one transaction does not change RLS scoping —
 * a member still sees only their own rows, and one with no data anywhere
 * gets well-formed empty results instead of an error.
 *
 * Requires a real PostgreSQL 16 instance (provided in CI via DATABASE_URL).
 * Skipped locally with a notice when DATABASE_URL is absent.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn(
    "[portal-home-aggregate.test] DATABASE_URL not set — skipping (runs in CI).",
  );
}

type Seed = {
  gymA: string;
  memberFull: string; // has an active program, an archived program, a workout log, a class booking, a plan + payment
  memberEmpty: string; // has nothing — proves the empty-state path
  progActive: string;
  progArchived: string;
};

const seed = {} as Seed;
const member = (tenantId: string, memberId: string): Identity => ({
  tenantId,
  role: "member",
  memberId,
});

describe.skipIf(!hasDb)("loadPortalHome (issue #32 aggregate query)", () => {
  beforeAll(async () => {
    await runMigrations();
    await withAdminContext(async (c) => {
      const gymA = (
        await c.query("insert into gym (name) values ($1) returning id", [
          "Portal Home Aggregate Gym",
        ])
      ).rows[0].id as string;

      const mem = async (fullName: string, membershipStatus: string) =>
        (
          await c.query(
            `insert into member (tenant_id, full_name, membership_status)
             values ($1, $2, $3) returning id`,
            [gymA, fullName, membershipStatus],
          )
        ).rows[0].id as string;

      const memberFull = await mem("Full Member", "active");
      const memberEmpty = await mem("Empty Member", "active");

      const prog = async (name: string) =>
        (
          await c.query(
            "insert into program (tenant_id, name) values ($1, $2) returning id",
            [gymA, name],
          )
        ).rows[0].id as string;

      const progActive = await prog("Active Program");
      const progArchived = await prog("Archived Program");

      await c.query(
        `insert into exercise (tenant_id, program_id, position, name, sets, reps, rest, notes)
         values ($1,$2,0,'Bench Press',5,'5','90s','')`,
        [gymA, progActive],
      );
      await c.query(
        `insert into program_assignment (tenant_id, program_id, member_id, status)
         values ($1,$2,$3,'active')`,
        [gymA, progActive, memberFull],
      );
      await c.query(
        `insert into program_assignment (tenant_id, program_id, member_id, status)
         values ($1,$2,$3,'archived')`,
        [gymA, progArchived, memberFull],
      );

      await c.query(
        `insert into workout_log (tenant_id, member_id, program_id, effort, note)
         values ($1,$2,$3,7,'Felt good')`,
        [gymA, memberFull, progActive],
      );

      const classId = (
        await c.query(
          `insert into classes (tenant_id, name, starts_at, duration_minutes, capacity)
           values ($1, 'Morning HIIT', now() + interval '1 day', 45, 10)
           returning id`,
          [gymA],
        )
      ).rows[0].id as string;
      await c.query(
        `insert into class_bookings (tenant_id, class_id, member_id, status)
         values ($1,$2,$3,'booked')`,
        [gymA, classId, memberFull],
      );

      const planId = (
        await c.query(
          `insert into membership_plans (tenant_id, name, tier, price_cents, currency)
           values ($1, 'Monthly', 'monthly', 5000, 'EUR')
           returning id`,
          [gymA],
        )
      ).rows[0].id as string;
      const memberPlanId = (
        await c.query(
          `insert into member_plans (tenant_id, member_id, plan_id, status)
           values ($1,$2,$3,'active')
           returning id`,
          [gymA, memberFull, planId],
        )
      ).rows[0].id as string;
      await c.query(
        `insert into payment_events (tenant_id, member_id, member_plan_id, amount_cents, currency, status)
         values ($1,$2,$3,5000,'EUR','succeeded')`,
        [gymA, memberFull, memberPlanId],
      );

      Object.assign(seed, {
        gymA,
        memberFull,
        memberEmpty,
        progActive,
        progArchived,
      });
    });
  });

  afterAll(async () => {
    await closePool();
  });

  it("returns every section for a member with data across all of them", async () => {
    const home = await loadPortalHome(
      member(seed.gymA, seed.memberFull),
      seed.memberFull,
    );

    expect(home.programs).toHaveLength(1);
    expect(home.programs[0].program.id).toBe(seed.progActive);
    expect(home.programs[0].exercises).toHaveLength(1);
    expect(home.programs[0].exercises[0].name).toBe("Bench Press");

    expect(home.history).toHaveLength(1);
    expect(home.history[0].id).toBe(seed.progArchived);

    expect(home.workouts).toHaveLength(1);
    expect(home.workouts[0].note).toBe("Felt good");

    expect(home.streakDays).toBeGreaterThanOrEqual(1);

    expect(home.classes).toHaveLength(1);
    expect(home.classes[0].booking_status).toBe("booked");

    expect(home.membershipStatus).toBe("active");

    expect(home.plans).toHaveLength(1);
    expect(home.plans[0].plan_name).toBe("Monthly");

    expect(home.paymentHistory).toHaveLength(1);
    expect(home.paymentHistory[0].amount_cents).toBe(5000);
  });

  it("returns well-formed empty results for a member with no data", async () => {
    const home = await loadPortalHome(
      member(seed.gymA, seed.memberEmpty),
      seed.memberEmpty,
    );

    // `classes` is the gym-wide upcoming schedule (a member browses it to
    // book), so it is not expected to be empty — the empty member simply has
    // no booking against the one seeded class.
    expect(home.classes).toHaveLength(1);
    expect(home.classes[0].booking_id).toBeNull();

    expect(home).toEqual({
      programs: [],
      history: [],
      workouts: [],
      streakDays: 0,
      classes: home.classes,
      membershipStatus: "active",
      plans: [],
      paymentHistory: [],
      // A member who has never asked for erasure has none on file. Part of the
      // aggregate rather than a ninth connection — see `loadPortalHome`.
      deletionRequest: null,
    });
  });

  it("a crafted memberId cannot pull another member's data into the aggregate", async () => {
    // Signed in as memberEmpty but passing memberFull's id: must not widen the
    // result, since every underlying query still scopes to app_current_member()
    // inside the shared transaction — RLS, not this function, is the boundary.
    const home = await loadPortalHome(
      member(seed.gymA, seed.memberEmpty),
      seed.memberFull,
    );

    expect(home.programs).toHaveLength(0);
    expect(home.workouts).toHaveLength(0);
    expect(home.paymentHistory).toHaveLength(0);
  });
});
