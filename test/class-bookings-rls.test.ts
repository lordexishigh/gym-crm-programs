import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import { closePool, withAdminContext, withTenantContext, type Identity } from "../lib/db";
import { bookClass, cancelBooking } from "../lib/classes";

/**
 * class_bookings self-update RLS (fixes the gap closed by migration 0020).
 *
 * `class_bookings_self_update` (0015) is documented as cancel-only ("a member
 * manages ONLY their own booking ... cancel = update to 'cancelled'"), but
 * until 0020 its WITH CHECK never actually constrained `status` — a member
 * session could set their own row to ANY status, including self-promoting a
 * waitlisted booking to 'booked' (bypassing `promoteFromWaitlist`'s capacity
 * check) or resurrecting a cancelled booking. These tests drive raw UPDATEs
 * under a real member session (never a superuser bypass) to prove the DB
 * layer — not application code — now rejects both, while the legitimate
 * self-cancel path (used by `cancelBooking`) still works.
 *
 * Requires a real PostgreSQL 16 instance (CI provides DATABASE_URL); skipped
 * locally with a notice when absent.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn(
    "[class-bookings-rls.test] DATABASE_URL not set — skipping (runs in CI).",
  );
}

type Seed = {
  gymA: string;
  memberA1: string;
  memberA2: string;
  fullClass: string; // capacity 1, already booked by memberA2 — memberA1 books into 'waitlisted'
  openClass: string; // capacity 1, unbooked — memberA1 books into 'booked', then cancels
};

const seed = {} as Seed;
const member = (tenantId: string, memberId: string): Identity => ({
  tenantId,
  role: "member",
  memberId,
});

async function bookingStatus(id: string): Promise<string> {
  return withAdminContext(async (c) => {
    const { rows } = await c.query<{ status: string }>(
      "select status from class_bookings where id = $1",
      [id],
    );
    return rows[0].status;
  });
}

describe.skipIf(!hasDb)("class_bookings self-update RLS (0020)", () => {
  beforeAll(async () => {
    await runMigrations();
    await withAdminContext(async (c) => {
      const gymA = (
        await c.query<{ id: string }>("insert into gym (name) values ('CB Gym A') returning id")
      ).rows[0].id;
      const mem = async (name: string) =>
        (
          await c.query<{ id: string }>(
            "insert into member (tenant_id, full_name) values ($1, $2) returning id",
            [gymA, name],
          )
        ).rows[0].id;
      const cls = async (name: string) =>
        (
          await c.query<{ id: string }>(
            `insert into classes (tenant_id, name, starts_at, duration_minutes, capacity)
             values ($1, $2, now() + interval '1 day', 60, 1) returning id`,
            [gymA, name],
          )
        ).rows[0].id;

      const memberA1 = await mem("CB Member A1");
      const memberA2 = await mem("CB Member A2");
      const fullClass = await cls("Full Class");
      const openClass = await cls("Open Class");

      // Fill the full class's only spot with a different member first, so
      // memberA1's own booking below lands as 'waitlisted'.
      await c.query(
        "insert into class_bookings (tenant_id, class_id, member_id, status) values ($1, $2, $3, 'booked')",
        [gymA, fullClass, memberA2],
      );

      Object.assign(seed, { gymA, memberA1, memberA2, fullClass, openClass });
    });
  });

  afterAll(async () => {
    await withAdminContext(async (c) => {
      await c.query("delete from gym where id = $1", [seed.gymA]);
    });
    await closePool();
  });

  it("a member cannot self-promote their own waitlisted booking to 'booked'", async () => {
    const result = await bookClass(member(seed.gymA, seed.memberA1), seed.memberA1, seed.fullClass);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("setup failed");
    expect(result.status).toBe("waitlisted");

    const bookingId = await withAdminContext(async (c) =>
      (
        await c.query<{ id: string }>(
          "select id from class_bookings where tenant_id = $1 and class_id = $2 and member_id = $3",
          [seed.gymA, seed.fullClass, seed.memberA1],
        )
      ).rows[0].id,
    );

    await expect(
      withTenantContext(member(seed.gymA, seed.memberA1), async (c) => {
        await c.query("update class_bookings set status = 'booked' where id = $1", [bookingId]);
      }),
    ).rejects.toThrow();

    expect(await bookingStatus(bookingId)).toBe("waitlisted");
  });

  it("a member cannot resurrect their own cancelled booking", async () => {
    const booked = await bookClass(member(seed.gymA, seed.memberA1), seed.memberA1, seed.openClass);
    expect(booked.ok).toBe(true);

    const bookingId = await withAdminContext(async (c) =>
      (
        await c.query<{ id: string }>(
          "select id from class_bookings where tenant_id = $1 and class_id = $2 and member_id = $3",
          [seed.gymA, seed.openClass, seed.memberA1],
        )
      ).rows[0].id,
    );

    const cancelled = await cancelBooking(member(seed.gymA, seed.memberA1), bookingId);
    expect(cancelled.ok).toBe(true);
    expect(await bookingStatus(bookingId)).toBe("cancelled");

    await expect(
      withTenantContext(member(seed.gymA, seed.memberA1), async (c) => {
        await c.query("update class_bookings set status = 'booked' where id = $1", [bookingId]);
      }),
    ).rejects.toThrow();
    await expect(
      withTenantContext(member(seed.gymA, seed.memberA1), async (c) => {
        await c.query("update class_bookings set status = 'waitlisted' where id = $1", [bookingId]);
      }),
    ).rejects.toThrow();

    expect(await bookingStatus(bookingId)).toBe("cancelled");
  });

  it("positive control: a member can still cancel their own active booking directly", async () => {
    // The previous test cancelled memberA1's booking on openClass, freeing its
    // one spot back up, so memberA2 books straight in (status 'booked').
    const booked = await bookClass(member(seed.gymA, seed.memberA2), seed.memberA2, seed.openClass);
    expect(booked.ok).toBe(true);
    if (booked.ok) expect(booked.status).toBe("booked");

    const bookingId = await withAdminContext(async (c) =>
      (
        await c.query<{ id: string }>(
          "select id from class_bookings where tenant_id = $1 and class_id = $2 and member_id = $3",
          [seed.gymA, seed.openClass, seed.memberA2],
        )
      ).rows[0].id,
    );

    const rowCount = await withTenantContext(member(seed.gymA, seed.memberA2), async (c) =>
      (
        await c.query(
          "update class_bookings set status = 'cancelled', cancelled_at = now() where id = $1",
          [bookingId],
        )
      ).rowCount,
    );
    expect(rowCount).toBe(1);
    expect(await bookingStatus(bookingId)).toBe("cancelled");
  });
});
