import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import { closePool, withAdminContext, type Identity } from "../lib/db";
import { bookClass } from "../lib/classes";

/**
 * Class booking gates on the BILLING lifecycle, not the portal flag.
 *
 * `bookClass` enforced capacity but never looked at `member.membership_status`,
 * so a member whose membership had expired or been cancelled could keep taking
 * class slots forever — and take them from paying members, since a booked slot
 * counts against capacity and pushes the next member onto the waitlist. That is
 * the revenue leak these tests pin shut.
 *
 * The asymmetry is deliberate and is the product's differentiator (migration
 * 0013 splits `status` — portal/roster — from `membership_status` — billing):
 * a frozen member LOSES class booking but KEEPS the portal, their programs and
 * workout logging. The frozen case below therefore also asserts the refusal
 * mentions the portal is still available, because a bare "you can't book" at a
 * freeze is what makes a paused member churn.
 *
 * Requires a real PostgreSQL 16 instance (CI provides DATABASE_URL); skipped
 * locally with a notice when absent.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn(
    "[class-booking-membership-gate.test] DATABASE_URL not set — skipping (runs in CI).",
  );
}

type MembershipStatus = "active" | "expired" | "frozen" | "cancelled";

type Seed = {
  gym: string;
  /** One member per status, so no test has to mutate another's row. */
  members: Record<MembershipStatus, string>;
  /** Capacity 4 — roomy, so a refusal can never be mistaken for "class full". */
  openClass: string;
};

const seed = {} as Seed;
const member = (tenantId: string, memberId: string): Identity => ({
  tenantId,
  role: "member",
  memberId,
});

/** Bookings actually persisted for a member on the shared class, any status. */
async function bookingCount(memberId: string): Promise<number> {
  return withAdminContext(async (c) => {
    const { rows } = await c.query<{ count: string }>(
      "select count(*)::text as count from class_bookings where tenant_id = $1 and class_id = $2 and member_id = $3",
      [seed.gym, seed.openClass, memberId],
    );
    return Number(rows[0].count);
  });
}

describe.skipIf(!hasDb)("class booking membership gate", () => {
  beforeAll(async () => {
    await runMigrations();
    await withAdminContext(async (c) => {
      const gym = (
        await c.query<{ id: string }>("insert into gym (name) values ('Gate Gym') returning id")
      ).rows[0].id;

      const statuses: MembershipStatus[] = ["active", "expired", "frozen", "cancelled"];
      const members = {} as Record<MembershipStatus, string>;
      for (const status of statuses) {
        members[status] = (
          await c.query<{ id: string }>(
            `insert into member (tenant_id, full_name, membership_status)
             values ($1, $2, $3) returning id`,
            [gym, `Gate Member ${status}`, status],
          )
        ).rows[0].id;
      }

      const openClass = (
        await c.query<{ id: string }>(
          `insert into classes (tenant_id, name, starts_at, duration_minutes, capacity)
           values ($1, 'Gate Class', now() + interval '1 day', 60, 4) returning id`,
          [gym],
        )
      ).rows[0].id;

      Object.assign(seed, { gym, members, openClass });
    });
  });

  afterAll(async () => {
    await withAdminContext(async (c) => {
      await c.query("delete from gym where id = $1", [seed.gym]);
    });
    await closePool();
  });

  it("lets a billing-active member book (positive control)", async () => {
    const id = seed.members.active;
    const result = await bookClass(member(seed.gym, id), id, seed.openClass);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("booked");
    expect(await bookingCount(id)).toBe(1);
  });

  for (const status of ["expired", "frozen", "cancelled"] as const) {
    it(`refuses a ${status} membership and writes no booking row`, async () => {
      const id = seed.members[status];
      const result = await bookClass(member(seed.gym, id), id, seed.openClass);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`a ${status} member was allowed to book`);
      // The class has capacity 4 and one booking, so a refusal here can only be
      // the membership gate — never a full class.
      expect(result.error).not.toMatch(/full|capacity|waitlist/i);

      // The real assertion: nothing persisted. A refusal that still inserted a
      // row would keep consuming the slot this change exists to protect.
      expect(await bookingCount(id)).toBe(0);
    });
  }

  it("tells a frozen member their portal and logging still work", async () => {
    const id = seed.members.frozen;
    const result = await bookClass(member(seed.gym, id), id, seed.openClass);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a frozen member was allowed to book");
    expect(result.error).toMatch(/paused/i);
    expect(result.error).toMatch(/program/i);
  });

  it("still refuses a member booking on someone else's behalf", async () => {
    // Pre-existing authorization check; asserted here so the new early return
    // above can never be reordered in front of it.
    const result = await bookClass(
      member(seed.gym, seed.members.active),
      seed.members.expired,
      seed.openClass,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not authorized/i);
  });
});
