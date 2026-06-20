import type { PoolClient } from "pg";

/**
 * Program-assignment lifecycle (alpha-program-lifecycle-001).
 *
 * The single source of truth for "give this member this program", shared by the
 * staff server action (`assignProgramAction`) and the lifecycle isolation test
 * so the two can never drift — the same convention as `lib/portal.ts`.
 *
 * The model: a member has at most ONE active program and any number of archived
 * ones (their history). Assigning a *different* program archives whichever
 * program was active; re-assigning the program that is already active is a
 * no-op refresh (its `assigned_at` is bumped). Both invariants are enforced
 * server-side: this function archives the prior active row, and migration 0003
 * adds a partial unique index that makes a second active row impossible.
 *
 * Must be called inside `withTenantContext` (as the RLS-bound `app_user`): the
 * tenant scoping comes from the session GUCs / RLS, so the queries here filter
 * only by member/program id and never need `where tenant_id = …`.
 */
export async function reassignProgram(
  c: PoolClient,
  params: {
    tenantId: string;
    programId: string;
    memberId: string;
    assignedBy: string | null;
  },
): Promise<void> {
  const { tenantId, programId, memberId, assignedBy } = params;

  // Archive any OTHER program currently active for this member. Doing this
  // first guarantees the partial unique index is never momentarily violated:
  // after this statement at most the target program remains active.
  await c.query(
    `update program_assignment
        set status = 'archived'
      where member_id = $1 and status = 'active' and program_id <> $2`,
    [memberId, programId],
  );

  // Upsert the target as the active program: reactivate an existing link
  // (whether it was active or archived), else create one.
  const updated = await c.query(
    `update program_assignment
        set status = 'active', assigned_at = now(), assigned_by = $3
      where program_id = $1 and member_id = $2`,
    [programId, memberId, assignedBy],
  );
  if ((updated.rowCount ?? 0) === 0) {
    await c.query(
      `insert into program_assignment
         (tenant_id, program_id, member_id, assigned_by)
       values ($1, $2, $3, $4)`,
      [tenantId, programId, memberId, assignedBy],
    );
  }
}
