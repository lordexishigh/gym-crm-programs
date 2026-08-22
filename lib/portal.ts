import type { PoolClient } from "pg";
import { withTenantContext, type Identity } from "./db";
import type { ExerciseRow, ProgramRow } from "./programs";
import {
  recentWorkoutLogsQuery,
  workoutStreakDaysQuery,
  RECENT_WORKOUTS_LIMIT,
  STREAK_LOOKBACK_DAYS,
  type WorkoutLogRow,
} from "./workout-logs";
import {
  listUpcomingClassesForMemberQuery,
  type MemberClassView,
} from "./classes";
import {
  memberPlansForQuery,
  memberMembershipStatusQuery,
  paymentHistoryForMemberQuery,
  PAYMENT_HISTORY_LIMIT,
  type PaymentEventRow,
} from "./billing";
import type { MemberPlanWithPlan } from "./plans";

/**
 * Member-portal read path (mvp-member-portal-001/002).
 *
 * The single source of truth for the member-scoped "what program am I assigned"
 * query, shared by the portal page (`app/portal/page.tsx`) and the
 * isolation test so the two can never drift. Isolation is enforced by RLS: under
 * a member session the `assignment_member_select`, `program_member_select`, and
 * `exercise_member_select` policies (migration 0002) make other members'/gyms'
 * rows invisible by construction. The explicit `member_id` filter is therefore
 * belt-and-suspenders, not the security boundary — which is exactly why the test
 * can pass a crafted, mismatched id and still get nothing back.
 */

/** A member's active assigned program plus the trainer-set assignment time. */
export type AssignedProgram = ProgramRow & { assigned_at: string };

/** An assigned program bundled with its ordered exercises, for rendering. */
export type PortalProgram = {
  program: AssignedProgram;
  exercises: ExerciseRow[];
};

/** The active-assignment query, kept in one place to prevent drift. */
const ACTIVE_PROGRAMS_SQL = `select p.id, p.name, p.description, p.created_at, p.updated_at,
        pa.assigned_at
   from program p
   join program_assignment pa on pa.program_id = p.id
  where pa.member_id = $1 and pa.status = 'active'
  order by pa.assigned_at desc`;

/**
 * Resolve the member's active assigned programs. RLS already constrains the
 * result to the caller's own assignments regardless of the `memberId` argument.
 */
export async function assignedPrograms(
  identity: Identity,
  memberId: string,
): Promise<AssignedProgram[]> {
  return withTenantContext(
    identity,
    async (c) =>
      (await c.query<AssignedProgram>(ACTIVE_PROGRAMS_SQL, [memberId])).rows,
  );
}

/**
 * Runs the assigned-programs-with-exercises query on an already-open
 * tenant-scoped client. Exported so `loadPortalHome` can fold this into the
 * single portal-page transaction below.
 */
async function loadMemberPortalQuery(
  client: PoolClient,
  memberId: string,
): Promise<PortalProgram[]> {
  const { rows: programs } = await client.query<AssignedProgram>(
    ACTIVE_PROGRAMS_SQL,
    [memberId],
  );
  if (programs.length === 0) return [];

  const { rows: exercises } = await client.query<ExerciseRow>(
    `select id, program_id, position, name, sets, reps, rest, notes
       from exercise
      where program_id = any($1::uuid[])
      order by program_id, position asc`,
    [programs.map((p) => p.id)],
  );

  const byProgram = new Map<string, ExerciseRow[]>();
  for (const ex of exercises) {
    const list = byProgram.get(ex.program_id) ?? [];
    list.push(ex);
    byProgram.set(ex.program_id, list);
  }

  return programs.map((program) => ({
    program,
    exercises: byProgram.get(program.id) ?? [],
  }));
}

/**
 * Load the member's assigned programs together with each program's ordered
 * exercises, in a single tenant transaction — the data the portal page renders.
 */
export async function loadMemberPortal(
  identity: Identity,
  memberId: string,
): Promise<PortalProgram[]> {
  return withTenantContext(identity, (c) => loadMemberPortalQuery(c, memberId));
}

/** The archived (past) assignments for the member's history list. */
const ARCHIVED_PROGRAMS_SQL = `select p.id, p.name, p.description, p.created_at, p.updated_at,
        pa.assigned_at
   from program p
   join program_assignment pa on pa.program_id = p.id
  where pa.member_id = $1 and pa.status = 'archived'
  order by pa.assigned_at desc`;

/**
 * Resolve the member's archived programs — their read-only history
 * (alpha-program-lifecycle-002). Summaries only (no exercises); the member taps
 * through to a detail page for the full read-only view. RLS scopes the result to
 * the caller's own assignments regardless of the `memberId` argument: the
 * member policies (migration 0002) carry no status filter, so a member can read
 * an archived assignment exactly as they can an active one.
 */
async function archivedProgramsQuery(
  client: PoolClient,
  memberId: string,
): Promise<AssignedProgram[]> {
  return (await client.query<AssignedProgram>(ARCHIVED_PROGRAMS_SQL, [memberId]))
    .rows;
}

export async function archivedPrograms(
  identity: Identity,
  memberId: string,
): Promise<AssignedProgram[]> {
  return withTenantContext(identity, (c) => archivedProgramsQuery(c, memberId));
}

/**
 * Load a single program assigned to the member (active OR archived), with its
 * ordered exercises — the data behind a history detail page. Returns null when
 * the program is not assigned to this member: RLS makes another member's or
 * another gym's program invisible, so a crafted id simply resolves to no row.
 */
export async function loadMemberProgram(
  identity: Identity,
  memberId: string,
  programId: string,
): Promise<PortalProgram | null> {
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<AssignedProgram>(
      `select p.id, p.name, p.description, p.created_at, p.updated_at,
              pa.assigned_at
         from program p
         join program_assignment pa on pa.program_id = p.id
        where pa.member_id = $1 and p.id = $2`,
      [memberId, programId],
    );
    const program = rows[0];
    if (!program) return null;

    const { rows: exercises } = await c.query<ExerciseRow>(
      `select id, program_id, position, name, sets, reps, rest, notes
         from exercise
        where program_id = $1
        order by position asc`,
      [programId],
    );

    return { program, exercises };
  });
}

/** Everything the portal home page (`app/portal/page.tsx`) renders. */
export type PortalHomeData = {
  programs: PortalProgram[];
  history: AssignedProgram[];
  workouts: WorkoutLogRow[];
  streakDays: number;
  classes: MemberClassView[];
  membershipStatus: "active" | "expired" | "frozen" | "cancelled" | null;
  plans: MemberPlanWithPlan[];
  paymentHistory: PaymentEventRow[];
};

/**
 * Load everything the portal home page renders in ONE tenant transaction
 * instead of 8 separate `withTenantContext` calls (issue #32: `/portal` was
 * ~2x slower than `/dashboard`). Each call pays its own 7 connection-setup
 * round trips (BEGIN, four `set_config`s, `SET LOCAL ROLE`, COMMIT) before it
 * can even run its query, and 8 at once mostly queue behind the deliberately
 * small pool (see `lib/db.ts`) instead of running concurrently. One
 * connection paying that setup cost once, then running the 8 queries in
 * sequence, does far fewer round trips overall.
 *
 * Each query is the exact SQL its standalone counterpart uses (the `*Query`
 * helpers are re-exported by their owning modules, not copied), so this is a
 * single source of truth. Isolation is unaffected: the GUCs are set once per
 * transaction either way, so folding queries into one transaction changes
 * nothing about what RLS allows.
 */
export async function loadPortalHome(
  identity: Identity,
  memberId: string,
): Promise<PortalHomeData> {
  return withTenantContext(identity, async (c) => {
    const programs = await loadMemberPortalQuery(c, memberId);
    const history = await archivedProgramsQuery(c, memberId);
    const workouts = await recentWorkoutLogsQuery(
      c,
      memberId,
      RECENT_WORKOUTS_LIMIT,
    );
    const streakDays = await workoutStreakDaysQuery(
      c,
      memberId,
      STREAK_LOOKBACK_DAYS,
    );
    const classes = await listUpcomingClassesForMemberQuery(c, memberId);
    const membershipStatus = await memberMembershipStatusQuery(c, memberId);
    const plans = await memberPlansForQuery(c, memberId);
    const paymentHistory = await paymentHistoryForMemberQuery(
      c,
      memberId,
      PAYMENT_HISTORY_LIMIT,
    );
    return {
      programs,
      history,
      workouts,
      streakDays,
      classes,
      membershipStatus,
      plans,
      paymentHistory,
    };
  });
}
