import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import {
  closePool,
  withAdminContext,
  withTenantContext,
  type Identity,
} from "../lib/db";
import { reassignProgram } from "../lib/assignments";
import {
  archivedPrograms,
  assignedPrograms,
  loadMemberProgram,
} from "../lib/portal";

/**
 * Program-lifecycle isolation tests (alpha-program-lifecycle-001/002).
 *
 * Drives the REAL assignment path (`reassignProgram`, shared with the staff
 * server action) and the REAL portal read path (`assignedPrograms`,
 * `archivedPrograms`, `loadMemberProgram`) under the RLS-bound roles, proving:
 *   - assigning a program makes it the member's single active program;
 *   - assigning a different program archives the previously-active one;
 *   - a member accumulates one active + several archived programs;
 *   - re-assigning an archived program reactivates it (no duplicate row);
 *   - the one-active-per-member invariant is enforced at the DB level;
 *   - a member can read their active program AND browse archived history, all
 *     member-scoped under RLS (other members'/gyms' rows stay invisible).
 *
 * Requires a real PostgreSQL 16 instance (provided in CI via DATABASE_URL).
 * Skipped locally with a notice when DATABASE_URL is absent.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn(
    "[program-lifecycle-rls.test] DATABASE_URL not set — skipping (runs in CI).",
  );
}

type Seed = {
  gymA: string;
  gymB: string;
  memberA: string;
  memberB: string;
  progA: string;
  progB: string;
  progC: string;
  progB2: string; // gym B program, assigned to memberB
};

const seed = {} as Seed;
const staff = (tenantId: string): Identity => ({ tenantId, role: "staff" });
const member = (tenantId: string, memberId: string): Identity => ({
  tenantId,
  role: "member",
  memberId,
});

/** Current assignment rows for a member (status by program), staff-scoped. */
const stateOf = (memberId: string) =>
  withTenantContext(staff(seed.gymA), async (c) =>
    (
      await c.query<{ program_id: string; status: string }>(
        "select program_id, status from program_assignment where member_id = $1",
        [memberId],
      )
    ).rows,
  );

const activeIds = (rows: { program_id: string; status: string }[]) =>
  rows.filter((r) => r.status === "active").map((r) => r.program_id);
const archivedIds = (rows: { program_id: string; status: string }[]) =>
  rows.filter((r) => r.status === "archived").map((r) => r.program_id);

/** Assign via the shared lifecycle helper, exactly as the staff action does. */
const assign = (programId: string, memberId: string) =>
  withTenantContext(staff(seed.gymA), (c) =>
    reassignProgram(c, {
      tenantId: seed.gymA,
      programId,
      memberId,
      assignedBy: null,
    }),
  );

describe.skipIf(!hasDb)("program lifecycle (active/archived) + history", () => {
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

      const gymA = await gym("Lifecycle Gym A");
      const gymB = await gym("Lifecycle Gym B");
      const memberA = await mem(gymA, "Life A");
      const memberB = await mem(gymB, "Life B");
      const progA = await prog(gymA, "Phase 1");
      const progB = await prog(gymA, "Phase 2");
      const progC = await prog(gymA, "Phase 3");
      const progB2 = await prog(gymB, "Gym B Phase 1");

      // memberB has an assignment in gym B (used for cross-tenant checks).
      await c.query(
        "insert into program_assignment (tenant_id, program_id, member_id) values ($1,$2,$3)",
        [gymB, progB2, memberB],
      );

      Object.assign(seed, {
        gymA,
        gymB,
        memberA,
        memberB,
        progA,
        progB,
        progC,
        progB2,
      });
    });
  });

  afterAll(async () => {
    await closePool();
  });

  it("assigning a program makes it the member's single active program", async () => {
    await assign(seed.progA, seed.memberA);
    const rows = await stateOf(seed.memberA);
    expect(activeIds(rows)).toEqual([seed.progA]);
    expect(archivedIds(rows)).toEqual([]);
  });

  it("assigning a different program archives the prior active one", async () => {
    await assign(seed.progB, seed.memberA);
    const rows = await stateOf(seed.memberA);
    expect(activeIds(rows)).toEqual([seed.progB]);
    expect(archivedIds(rows)).toEqual([seed.progA]);
  });

  it("a member accumulates one active and several archived programs", async () => {
    await assign(seed.progC, seed.memberA);
    const rows = await stateOf(seed.memberA);
    expect(activeIds(rows)).toEqual([seed.progC]);
    expect(archivedIds(rows).sort()).toEqual([seed.progA, seed.progB].sort());
  });

  it("re-assigning an archived program reactivates it without duplicating rows", async () => {
    await assign(seed.progA, seed.memberA);
    const rows = await stateOf(seed.memberA);
    expect(activeIds(rows)).toEqual([seed.progA]);
    expect(archivedIds(rows).sort()).toEqual([seed.progB, seed.progC].sort());
    // Exactly one row per (member, program) — reactivation, not insert.
    expect(rows).toHaveLength(3);
  });

  it("enforces one active program per member at the DB level", async () => {
    // progA is active; forcing a second active row for the same member must be
    // rejected by the partial unique index (uq_assignment_one_active_per_member).
    await expect(
      withTenantContext(staff(seed.gymA), async (c) => {
        await c.query(
          `insert into program_assignment (tenant_id, program_id, member_id, status)
           values ($1, $2, $3, 'active')`,
          [seed.gymA, seed.progB, seed.memberA],
        );
      }),
    ).rejects.toThrow();
  });

  it("the member sees their active program by default", async () => {
    const rows = await assignedPrograms(
      member(seed.gymA, seed.memberA),
      seed.memberA,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(seed.progA);
  });

  it("the member can browse their archived history (read-only)", async () => {
    const history = await archivedPrograms(
      member(seed.gymA, seed.memberA),
      seed.memberA,
    );
    expect(history.map((p) => p.id).sort()).toEqual(
      [seed.progB, seed.progC].sort(),
    );

    // An archived program loads in full for the read-only detail page.
    const detail = await loadMemberProgram(
      member(seed.gymA, seed.memberA),
      seed.memberA,
      seed.progB,
    );
    expect(detail?.program.id).toBe(seed.progB);
  });

  it("history is member-scoped under RLS (cannot read across member or tenant)", async () => {
    // Crafting another member's id still returns only the caller's history.
    const crafted = await archivedPrograms(
      member(seed.gymA, seed.memberA),
      seed.memberB,
    );
    expect(crafted).toHaveLength(0);

    // Another gym's program is invisible even when fetched directly by id.
    const crossTenant = await loadMemberProgram(
      member(seed.gymA, seed.memberA),
      seed.memberA,
      seed.progB2,
    );
    expect(crossTenant).toBeNull();
  });
});
