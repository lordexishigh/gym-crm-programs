import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import {
  closePool,
  withAdminContext,
  withTenantContext,
  type Identity,
} from "../lib/db";
import {
  ERASED_INVITE_EMAIL,
  ERASED_MEMBER_NAME,
  anonymiseMember,
  anonymiseStaff,
} from "../lib/gdpr/export";

/**
 * GDPR erasure / anonymisation tests (beta-gdpr-002).
 *
 * Require a real PostgreSQL 16 instance (CI provides one; skipped locally
 * without DATABASE_URL). They assert: a subject can be erased; erasure
 * anonymises PII while PRESERVING referential integrity (the assignment that
 * references the member survives); it is idempotent; it never touches another
 * tenant's rows; and it is logged for audit. Members here have no auth account,
 * so the Supabase admin delete-user path is not exercised.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn(
    "[gdpr-erasure.test] DATABASE_URL not set — skipping (runs in CI).",
  );
}

const staff = (tenantId: string): Identity => ({ tenantId, role: "staff" });

describe.skipIf(!hasDb)("GDPR erasure — anonymise & isolate", () => {
  afterAll(async () => {
    await closePool();
  });

  beforeAll(async () => {
    await runMigrations();
  });

  it("anonymises a member while preserving referential integrity", async () => {
    const { gymA, memberId, assignmentId } = await withAdminContext(async (c) => {
      const gymA = (
        await c.query("insert into gym (name) values ('Erase Gym A') returning id")
      ).rows[0].id as string;
      const memberId = (
        await c.query(
          "insert into member (tenant_id, full_name, email, phone, notes) values ($1,'Dana','dana@a.example','+357 1','note') returning id",
          [gymA],
        )
      ).rows[0].id as string;
      const programId = (
        await c.query(
          "insert into program (tenant_id, name) values ($1,'P') returning id",
          [gymA],
        )
      ).rows[0].id as string;
      const assignmentId = (
        await c.query(
          "insert into program_assignment (tenant_id, program_id, member_id) values ($1,$2,$3) returning id",
          [gymA, programId, memberId],
        )
      ).rows[0].id as string;
      await c.query(
        "insert into invite (tenant_id, member_id, email, token_hash, status) values ($1,$2,'dana@a.example','h','pending')",
        [gymA, memberId],
      );
      return { gymA, memberId, assignmentId };
    });

    const result = await anonymiseMember(staff(gymA), memberId);
    expect(result).toEqual({ ok: true, alreadyErased: false });

    await withAdminContext(async (c) => {
      const m = (
        await c.query(
          "select full_name, email, phone, notes, status, auth_user_id, erased_at from member where id = $1",
          [memberId],
        )
      ).rows[0];
      // Row kept, PII tombstoned/nulled, erased_at stamped.
      expect(m.full_name).toBe(ERASED_MEMBER_NAME);
      expect(m.email).toBeNull();
      expect(m.phone).toBeNull();
      expect(m.notes).toBeNull();
      expect(m.status).toBe("inactive");
      expect(m.auth_user_id).toBeNull();
      expect(m.erased_at).not.toBeNull();

      // Referential integrity: the assignment that references the member survives.
      const assignment = await c.query(
        "select id from program_assignment where id = $1",
        [assignmentId],
      );
      expect(assignment.rows).toHaveLength(1);

      // Invite PII scrubbed and pending invite revoked.
      const invite = (
        await c.query(
          "select email, status from invite where member_id = $1",
          [memberId],
        )
      ).rows[0];
      expect(invite.email).toBe(ERASED_INVITE_EMAIL);
      expect(invite.status).toBe("revoked");

      // Erasure logged for audit.
      const audit = (
        await c.query(
          "select count(*)::int as n from gdpr_audit_event where action = 'erasure' and subject_member_id = $1",
          [memberId],
        )
      ).rows[0];
      expect(audit.n as number).toBeGreaterThan(0);
    });
  });

  it("is idempotent (re-erasing reports alreadyErased)", async () => {
    const { gymA, memberId } = await withAdminContext(async (c) => {
      const gymA = (
        await c.query("insert into gym (name) values ('Erase Gym Idem') returning id")
      ).rows[0].id as string;
      const memberId = (
        await c.query(
          "insert into member (tenant_id, full_name, email) values ($1,'Eve','eve@a.example') returning id",
          [gymA],
        )
      ).rows[0].id as string;
      return { gymA, memberId };
    });

    expect(await anonymiseMember(staff(gymA), memberId)).toEqual({
      ok: true,
      alreadyErased: false,
    });
    expect(await anonymiseMember(staff(gymA), memberId)).toEqual({
      ok: true,
      alreadyErased: true,
    });
  });

  it("cannot erase a member in another tenant (no cross-tenant leakage)", async () => {
    const { gymA, gymB, memberA } = await withAdminContext(async (c) => {
      const gymA = (
        await c.query("insert into gym (name) values ('Erase Gym X') returning id")
      ).rows[0].id as string;
      const gymB = (
        await c.query("insert into gym (name) values ('Erase Gym Y') returning id")
      ).rows[0].id as string;
      const memberA = (
        await c.query(
          "insert into member (tenant_id, full_name, email) values ($1,'Frank','frank@x.example') returning id",
          [gymA],
        )
      ).rows[0].id as string;
      return { gymA, gymB, memberA };
    });

    // Staff in gym B try to erase gym A's member — invisible under RLS.
    const result = await anonymiseMember(staff(gymB), memberA);
    expect(result).toEqual({ ok: false, reason: "not_found" });

    // The member in gym A is untouched.
    await withAdminContext(async (c) => {
      const m = (
        await c.query("select full_name, erased_at from member where id = $1", [
          memberA,
        ])
      ).rows[0];
      expect(m.full_name).toBe("Frank");
      expect(m.erased_at).toBeNull();
    });
  });

  it("anonymises a staff data subject and logs it", async () => {
    const { gymA, staffId } = await withAdminContext(async (c) => {
      const gymA = (
        await c.query("insert into gym (name) values ('Erase Gym Staff') returning id")
      ).rows[0].id as string;
      const staffId = (
        await c.query(
          "insert into users (tenant_id, email, full_name) values ($1,'gone@a.example','Gone Trainer') returning id",
          [gymA],
        )
      ).rows[0].id as string;
      return { gymA, staffId };
    });

    const result = await anonymiseStaff(staff(gymA), staffId);
    expect(result).toEqual({ ok: true, alreadyErased: false });

    await withAdminContext(async (c) => {
      const u = (
        await c.query(
          "select email, full_name, auth_user_id, erased_at from users where id = $1",
          [staffId],
        )
      ).rows[0];
      expect(u.email).not.toBe("gone@a.example");
      expect(u.email).toContain("@invalid.example");
      expect(u.full_name).toBeNull();
      expect(u.erased_at).not.toBeNull();

      const audit = (
        await c.query(
          "select count(*)::int as n from gdpr_audit_event where action = 'erasure' and subject_user_id = $1",
          [staffId],
        )
      ).rows[0];
      expect(audit.n as number).toBeGreaterThan(0);
    });
  });
});
