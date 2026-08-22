import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import {
  closePool,
  withAdminContext,
  withTenantContext,
  type Identity,
} from "../lib/db";

/**
 * Front-desk role enforcement at the DATABASE layer (migration 0026).
 *
 * test/staff-permissions.test.ts proves the application guard refuses the
 * front-desk role, and that every dashboard route calls it. This suite proves
 * the other half: that the refusal still holds for a query that never went
 * through a guard at all — a Server Action added later that forgets the check,
 * or a helper called from an unguarded context. Every assertion drives a raw
 * statement under a real front-desk session (`app.staff_role = 'front_desk'`),
 * never a superuser bypass.
 *
 * The pairing matters as much as the denials: an owner session runs the SAME
 * statements and must still succeed, or the policies would be a regression
 * dressed up as a security fix.
 *
 * Requires a real PostgreSQL 16 instance (CI provides DATABASE_URL); skipped
 * locally with a notice when absent.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn("[front-desk-rls.test] DATABASE_URL not set — skipping (runs in CI).");
}

type Seed = {
  gym: string;
  member: string;
  program: string;
  plan: string;
  deskAuthId: string;
  ownerAuthId: string;
};

const seed = {} as Seed;

/** A staff session carrying a job role, exactly as `requireStaff` builds one. */
const staff = (
  tenantId: string,
  staffRole: "owner" | "trainer" | "front_desk",
  userId: string,
): Identity => ({ tenantId, role: "staff", staffRole, userId });

describe.skipIf(!hasDb)("front-desk role enforcement (0026)", () => {
  beforeAll(async () => {
    await runMigrations();

    await withAdminContext(async (c) => {
      const gym = (
        await c.query<{ id: string }>(
          "insert into gym (name) values ('Front Desk Gym') returning id",
        )
      ).rows[0].id;

      const staffRow = async (email: string, role: string) =>
        (
          await c.query<{ auth_user_id: string }>(
            `insert into users (tenant_id, email, full_name, role, auth_user_id)
               values ($1, $2, $2, $3, gen_random_uuid())
             returning auth_user_id`,
            [gym, email, role],
          )
        ).rows[0].auth_user_id;

      // The insert itself is the first assertion that 0026 widened the check
      // constraint: before it, this row was rejected outright.
      const deskAuthId = await staffRow("desk@fd.test", "front_desk");
      const ownerAuthId = await staffRow("owner@fd.test", "owner");

      const member = (
        await c.query<{ id: string }>(
          "insert into member (tenant_id, full_name) values ($1, 'FD Member') returning id",
          [gym],
        )
      ).rows[0].id;

      const program = (
        await c.query<{ id: string }>(
          "insert into program (tenant_id, name) values ($1, 'FD Program') returning id",
          [gym],
        )
      ).rows[0].id;

      const plan = (
        await c.query<{ id: string }>(
          `insert into membership_plans (tenant_id, name, tier, price_cents)
             values ($1, 'FD Monthly', 'monthly', 5000) returning id`,
          [gym],
        )
      ).rows[0].id;

      await c.query(
        `insert into member_plans (tenant_id, member_id, plan_id, status)
           values ($1, $2, $3, 'active')`,
        [gym, member, plan],
      );

      // Attendance: the one member-history read the front desk MUST keep.
      await c.query(
        "insert into check_ins (tenant_id, member_id, method) values ($1, $2, 'pin')",
        [gym, member],
      );

      Object.assign(seed, { gym, member, program, plan, deskAuthId, ownerAuthId });
    });
  }, 120_000);

  afterAll(async () => {
    if (seed.gym) {
      await withAdminContext((c) =>
        c.query("delete from gym where id = $1", [seed.gym]),
      );
    }
    await closePool();
  });

  const desk = () => staff(seed.gym, "front_desk", seed.deskAuthId);
  const owner = () => staff(seed.gym, "owner", seed.ownerAuthId);

  it("stores the front_desk role (the 0001 check constraint rejected it)", async () => {
    const role = await withAdminContext(
      async (c) =>
        (
          await c.query<{ role: string }>(
            "select role from users where auth_user_id = $1",
            [seed.deskAuthId],
          )
        ).rows[0].role,
    );
    expect(role).toBe("front_desk");
  });

  it("lets front desk check a member in and read their attendance", async () => {
    const visits = await withTenantContext(desk(), async (c) => {
      await c.query(
        "insert into check_ins (tenant_id, member_id, method) values ($1, $2, 'qr')",
        [seed.gym, seed.member],
      );
      return (
        await c.query("select id from check_ins where member_id = $1", [seed.member])
      ).rowCount;
    });
    expect(visits).toBe(2);
  });

  it("lets front desk read the member record it is looking up", async () => {
    const rows = await withTenantContext(
      desk(),
      async (c) =>
        (await c.query("select id from member where id = $1", [seed.member])).rowCount,
    );
    expect(rows).toBe(1);
  });

  it("hides payment records from front desk and shows them to the owner", async () => {
    const asDesk = await withTenantContext(desk(), async (c) => ({
      plans: (await c.query("select id from membership_plans")).rowCount,
      subs: (await c.query("select id from member_plans")).rowCount,
    }));
    expect(asDesk.plans).toBe(0);
    expect(asDesk.subs).toBe(0);

    const asOwner = await withTenantContext(owner(), async (c) => ({
      plans: (await c.query("select id from membership_plans")).rowCount,
      subs: (await c.query("select id from member_plans")).rowCount,
    }));
    expect(asOwner.plans).toBe(1);
    expect(asOwner.subs).toBe(1);
  });

  it("refuses a front-desk write to the program tables", async () => {
    // INSERT trips WITH CHECK, which RAISES. UPDATE/DELETE trip USING, which
    // filters instead — the row is simply not there to modify, so the statement
    // succeeds against nothing. Both are denials; they just fail differently,
    // and asserting the wrong shape is how a "passing" RLS test proves nothing.
    await expect(
      withTenantContext(desk(), (c) =>
        c.query("insert into program (tenant_id, name) values ($1, 'Sneaky')", [
          seed.gym,
        ]),
      ),
    ).rejects.toThrow();

    const touched = await withTenantContext(desk(), async (c) => ({
      updated: (
        await c.query("update program set name = 'Renamed' where id = $1", [
          seed.program,
        ])
      ).rowCount,
      deleted: (
        await c.query("delete from program where id = $1", [seed.program])
      ).rowCount,
    }));
    expect(touched.updated).toBe(0);
    expect(touched.deleted).toBe(0);

    const name = await withAdminContext(
      async (c) =>
        (
          await c.query<{ name: string }>("select name from program where id = $1", [
            seed.program,
          ])
        ).rows[0].name,
    );
    expect(name).toBe("FD Program");
  });

  it("refuses a front-desk program assignment", async () => {
    await expect(
      withTenantContext(desk(), (c) =>
        c.query(
          `insert into program_assignment (tenant_id, program_id, member_id, status)
             values ($1, $2, $3, 'active')`,
          [seed.gym, seed.program, seed.member],
        ),
      ),
    ).rejects.toThrow();
  });

  it("still lets an owner write to the program tables", async () => {
    const inserted = await withTenantContext(
      owner(),
      async (c) =>
        (
          await c.query(
            "insert into program (tenant_id, name) values ($1, 'Owner Program') returning id",
            [seed.gym],
          )
        ).rowCount,
    );
    expect(inserted).toBe(1);
  });

  it("shows front desk its own users row and no colleague's", async () => {
    const rows = await withTenantContext(
      desk(),
      async (c) =>
        (await c.query<{ email: string }>("select email from users")).rows,
    );
    expect(rows.map((r) => r.email)).toEqual(["desk@fd.test"]);
  });

  it("refuses a front-desk write to any users row, including its own", async () => {
    await expect(
      withTenantContext(desk(), (c) =>
        c.query("update users set role = 'owner' where auth_user_id = $1", [
          seed.deskAuthId,
        ]),
      ),
    ).rejects.toThrow();

    const role = await withAdminContext(
      async (c) =>
        (
          await c.query<{ role: string }>(
            "select role from users where auth_user_id = $1",
            [seed.deskAuthId],
          )
        ).rows[0].role,
    );
    expect(role).toBe("front_desk");
  });
});
