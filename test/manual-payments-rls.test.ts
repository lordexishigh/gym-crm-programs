import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import { closePool, withAdminContext, withTenantContext, type Identity } from "../lib/db";
import {
  manualPaymentsForMember,
  recordManualPayment,
  revenueTotals,
  voidManualPayment,
} from "../lib/payments";
import { ERASED_PAYMENT_TEXT, anonymiseMember, exportMemberData } from "../lib/gdpr/export";

/**
 * Off-card payment logging (migration 0026): isolation, the absence of a member
 * write path, and the GDPR surfaces.
 *
 * `docs/RISKY-DEFERRED.md` flagged this feature's shape as the reason it was
 * deferred: it spans the write path, RLS, GDPR export AND erasure at once, and a
 * half-done version is worse than none — payment data that erasure forgets to
 * scrub is a compliance gap, not a missing feature. These tests are the proof
 * that none of those four is missing.
 *
 * Requires a real PostgreSQL 16 instance (CI provides DATABASE_URL); skipped
 * locally with a notice when absent.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn("[manual-payments-rls.test] DATABASE_URL not set — skipping (runs in CI).");
}

type Seed = {
  gymA: string;
  gymB: string;
  staffA: string;
  staffAuthA: string;
  memberA1: string;
  memberA2: string;
  memberB1: string;
};

const seed = {} as Seed;
const staff = (tenantId: string, userId: string): Identity => ({
  tenantId,
  role: "staff",
  userId,
});
const member = (tenantId: string, memberId: string): Identity => ({
  tenantId,
  role: "member",
  memberId,
});

const VALID = {
  amountCents: 12000,
  currency: "EUR",
  method: "sepa" as const,
  reference: "SEPA-REF-001",
  note: "annual membership, paid by transfer",
  receivedOn: "2026-01-10",
};

describe.skipIf(!hasDb)("manual_payment isolation + GDPR (0026)", () => {
  beforeAll(async () => {
    await runMigrations();
    await withAdminContext(async (c) => {
      const gym = async (name: string) =>
        (await c.query<{ id: string }>("insert into gym (name) values ($1) returning id", [name]))
          .rows[0].id;
      const gymA = await gym("MP Gym A");
      const gymB = await gym("MP Gym B");

      const staffAuthA = (
        await c.query<{ auth_user_id: string }>(
          `insert into users (tenant_id, email, full_name, role, auth_user_id)
           values ($1, 'owner-a@mp.local', 'Owner A', 'owner', gen_random_uuid())
           returning auth_user_id`,
          [gymA],
        )
      ).rows[0].auth_user_id;
      const staffA = (
        await c.query<{ id: string }>("select id from users where auth_user_id = $1", [staffAuthA])
      ).rows[0].id;

      const mem = async (tenant: string, name: string) =>
        (
          await c.query<{ id: string }>(
            "insert into member (tenant_id, full_name) values ($1, $2) returning id",
            [tenant, name],
          )
        ).rows[0].id;

      Object.assign(seed, {
        gymA,
        gymB,
        staffA,
        staffAuthA,
        memberA1: await mem(gymA, "MP Member A1"),
        memberA2: await mem(gymA, "MP Member A2"),
        memberB1: await mem(gymB, "MP Member B1"),
      });
    });
  });

  afterAll(async () => {
    await withAdminContext(async (c) => {
      await c.query("delete from gym where id = any($1::uuid[])", [[seed.gymA, seed.gymB]]);
    });
    await closePool();
  });

  it("records a payment and attributes it to the acting staff user", async () => {
    const result = await recordManualPayment(
      staff(seed.gymA, seed.staffAuthA),
      seed.memberA1,
      VALID,
    );
    expect(result.ok).toBe(true);

    const rows = await manualPaymentsForMember(staff(seed.gymA, seed.staffAuthA), seed.memberA1);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe(12000);
    expect(rows[0].method).toBe("sepa");
    expect(rows[0].reference).toBe("SEPA-REF-001");
    // Provenance comes from the verified session, not the form.
    expect(rows[0].entered_by).toBe(seed.staffA);
    expect(rows[0].entered_by_name).toBe("Owner A");
    expect(rows[0].voided_at).toBe(null);
  });

  it("a member sees their own payments and NOT another member's", async () => {
    const mine = await manualPaymentsForMember(
      member(seed.gymA, seed.memberA1),
      seed.memberA1,
    );
    expect(mine).toHaveLength(1);

    // memberA2 asking for A1's rows: RLS filters by app_current_member(), so the
    // predicate in the SQL is irrelevant — nothing comes back.
    const notMine = await manualPaymentsForMember(
      member(seed.gymA, seed.memberA2),
      seed.memberA1,
    );
    expect(notMine).toHaveLength(0);
  });

  it("staff in another tenant cannot see the payment", async () => {
    const crossTenant = await manualPaymentsForMember(
      staff(seed.gymB, seed.staffAuthA),
      seed.memberA1,
    );
    expect(crossTenant).toHaveLength(0);
  });

  // A member must never be able to assert that they paid cash. The policy is
  // SELECT-only, so the DB — not application code — has to refuse this.
  it("a member cannot insert a payment for themselves", async () => {
    await expect(
      withTenantContext(member(seed.gymA, seed.memberA1), async (c) => {
        await c.query(
          `insert into manual_payment (tenant_id, member_id, amount_cents, currency, method, received_on)
           values ($1, $2, 99900, 'EUR', 'cash', current_date)`,
          [seed.gymA, seed.memberA1],
        );
      }),
    ).rejects.toThrow();
  });

  it("refuses a member identity at the application boundary too", async () => {
    const result = await recordManualPayment(
      member(seed.gymA, seed.memberA1),
      seed.memberA1,
      VALID,
    );
    expect(result.ok).toBe(false);
  });

  it("the database rejects a void with no reason", async () => {
    const id = (
      await manualPaymentsForMember(staff(seed.gymA, seed.staffAuthA), seed.memberA1)
    )[0].id;
    await expect(
      withAdminContext(async (c) => {
        await c.query("update manual_payment set voided_at = now() where id = $1", [id]);
      }),
    ).rejects.toThrow();
  });

  it("voids once and treats a second void as a no-op, preserving the audit trail", async () => {
    const id = (
      await manualPaymentsForMember(staff(seed.gymA, seed.staffAuthA), seed.memberA1)
    )[0].id;

    const first = await voidManualPayment(
      staff(seed.gymA, seed.staffAuthA),
      id,
      "entered twice by mistake",
    );
    expect(first.ok).toBe(true);

    const afterFirst = (
      await manualPaymentsForMember(staff(seed.gymA, seed.staffAuthA), seed.memberA1)
    )[0];
    expect(afterFirst.void_reason).toBe("entered twice by mistake");
    expect(afterFirst.voided_by_name).toBe("Owner A");
    const stamp = afterFirst.voided_at;

    const second = await voidManualPayment(staff(seed.gymA, seed.staffAuthA), id, "different reason");
    expect(second.ok).toBe(false);

    const afterSecond = (
      await manualPaymentsForMember(staff(seed.gymA, seed.staffAuthA), seed.memberA1)
    )[0];
    expect(afterSecond.void_reason).toBe("entered twice by mistake");
    // `toEqual`, not `toBe`: pg hands a timestamptz back as a Date instance, so
    // two reads of the same unchanged row are equal in value but not identical.
    expect(afterSecond.voided_at).toEqual(stamp);
  });

  it("excludes voided payments from the revenue totals", async () => {
    const before = await revenueTotals(
      staff(seed.gymA, seed.staffAuthA),
      "2026-01-01",
      "2026-12-31",
    );
    // The only payment so far is the voided one.
    expect(before.manual_cents).toBe(0);

    await recordManualPayment(staff(seed.gymA, seed.staffAuthA), seed.memberA2, {
      ...VALID,
      amountCents: 5000,
      reference: null,
      note: null,
    });

    const after = await revenueTotals(
      staff(seed.gymA, seed.staffAuthA),
      "2026-01-01",
      "2026-12-31",
    );
    expect(after.manual_cents).toBe(5000);
    expect(after.combined_cents).toBe(after.stripe_cents + after.manual_cents);
  });

  it("scopes the revenue totals to the tenant", async () => {
    const other = await revenueTotals(staff(seed.gymB, seed.staffAuthA), "2026-01-01", "2026-12-31");
    expect(other.manual_cents).toBe(0);
  });

  it("includes manual payments and card payments in the GDPR export", async () => {
    // A card payment too, so the export covers the half that was missing before.
    await withAdminContext(async (c) => {
      await c.query(
        `insert into payment_events (tenant_id, member_id, amount_cents, currency, status)
         values ($1, $2, 7700, 'EUR', 'succeeded')`,
        [seed.gymA, seed.memberA2],
      );
    });

    const { data } = await exportMemberData(staff(seed.gymA, seed.staffAuthA), seed.memberA2);
    expect(data).not.toBe(null);
    expect(data?.manual_payments).toHaveLength(1);
    expect(data?.manual_payments[0].amount_cents).toBe(5000);
    expect(data?.payment_events).toHaveLength(1);
    expect(data?.payment_events[0].amount_cents).toBe(7700);
  });

  it("a member's own export carries their payments too", async () => {
    const { data } = await exportMemberData(member(seed.gymA, seed.memberA2), seed.memberA2);
    expect(data?.manual_payments).toHaveLength(1);
    expect(data?.payment_events).toHaveLength(1);
  });

  /**
   * The assertion `docs/RISKY-DEFERRED.md` was worried about: erasure must scrub
   * the free text while KEEPING the financial record, because the gym's
   * statutory books survive an erasure request (Art. 17(3)(b)).
   */
  it("erasure scrubs the free text but keeps the amount, method and date", async () => {
    // memberA1 has the voided payment, so this covers void_reason as well.
    const before = (
      await manualPaymentsForMember(staff(seed.gymA, seed.staffAuthA), seed.memberA1)
    )[0];
    expect(before.note).not.toBe(null);
    expect(before.reference).not.toBe(null);
    expect(before.void_reason).not.toBe(null);

    const erased = await anonymiseMember(staff(seed.gymA, seed.staffAuthA), seed.memberA1);
    expect(erased.ok).toBe(true);

    const after = (
      await manualPaymentsForMember(staff(seed.gymA, seed.staffAuthA), seed.memberA1)
    )[0];
    // Row survives — it is the controller's accounts, not the subject's profile.
    expect(after).toBeDefined();
    expect(after.amount_cents).toBe(12000);
    expect(after.method).toBe("sepa");
    expect(after.received_on).toBeTruthy();
    // Everything identifying is gone.
    expect(after.note).toBe(null);
    expect(after.reference).toBe(null);
    // Voided rows must keep a non-null reason to satisfy the void CHECK, so this
    // is tombstoned rather than nulled.
    expect(after.void_reason).toBe(ERASED_PAYMENT_TEXT);
    expect(after.voided_at).not.toBe(null);
  });

  it("erasure leaves a never-voided payment's void columns null", async () => {
    const erased = await anonymiseMember(staff(seed.gymA, seed.staffAuthA), seed.memberA2);
    expect(erased.ok).toBe(true);

    const after = (
      await manualPaymentsForMember(staff(seed.gymA, seed.staffAuthA), seed.memberA2)
    )[0];
    expect(after.amount_cents).toBe(5000);
    // The CHECK requires both null together; a blanket tombstone would violate it.
    expect(after.voided_at).toBe(null);
    expect(after.void_reason).toBe(null);
  });
});
