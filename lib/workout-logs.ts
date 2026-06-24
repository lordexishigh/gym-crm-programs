import { withTenantContext, type Identity } from "./db";

/**
 * Member workout-session logging (Phase GA — ga-engagement-001).
 *
 * The data layer for the first member-WRITTEN entity. Validation is a PURE
 * function (no DB, no env) so it runs in the Server Action before any query and
 * is unit-testable in isolation — mirroring `lib/programs.ts` and
 * `lib/members.ts`. The database still enforces the hard invariants (the
 * effort CHECK, the composite (id, tenant_id) FKs) and RLS does the security:
 * under a member session the `workout_log_member_*` policies (migration 0008)
 * scope every read/write to the caller's own rows, so the `member_id` we pass is
 * belt-and-suspenders, not the boundary.
 */

/** A logged workout session, joined to its program name for display. */
export type WorkoutLogRow = {
  id: string;
  program_id: string;
  /** Program name via inner join — always present (the FK cascades). */
  program_name: string;
  completed_at: string;
  /** Perceived effort, RPE 1-10. Null when the member skipped it. */
  effort: number | null;
  note: string | null;
};

/** Normalised, validated values ready to persist. */
export type WorkoutLogInput = {
  programId: string;
  /** RPE 1-10, or null when not given. */
  effort: number | null;
  note: string | null;
};

export type WorkoutLogValidationResult =
  | { ok: true; value: WorkoutLogInput }
  | { ok: false; error: string };

const NOTE_MAX = 1000;
const EFFORT_MIN = 1;
const EFFORT_MAX = 10;
// Matches the canonical UUID shape; the DB FK is the real authority, this just
// rejects obviously bad input with a friendly message before a round-trip.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate + normalise raw form values into a `WorkoutLogInput`.
 *
 * Rules:
 *   - programId is REQUIRED and must look like a UUID (RLS still verifies the
 *     member is actually assigned to it).
 *   - effort is optional; when present it must be a whole number 1..10 (RPE).
 *   - note is optional free text, capped at a sane length.
 */
export function validateWorkoutLogInput(raw: {
  programId?: unknown;
  effort?: unknown;
  note?: unknown;
}): WorkoutLogValidationResult {
  const programId =
    typeof raw.programId === "string" ? raw.programId.trim() : "";
  if (!programId) {
    return { ok: false, error: "Choose which program you trained." };
  }
  if (!UUID_RE.test(programId)) {
    return { ok: false, error: "That program is not valid." };
  }

  let effort: number | null = null;
  const effortRaw = raw.effort;
  const effortStr =
    typeof effortRaw === "number"
      ? String(effortRaw)
      : typeof effortRaw === "string"
        ? effortRaw.trim()
        : "";
  if (effortStr !== "") {
    const n = Number(effortStr);
    if (!Number.isInteger(n) || n < EFFORT_MIN || n > EFFORT_MAX) {
      return {
        ok: false,
        error: `Effort must be a whole number from ${EFFORT_MIN} to ${EFFORT_MAX}.`,
      };
    }
    effort = n;
  }

  const noteRaw = typeof raw.note === "string" ? raw.note.trim() : "";
  if (noteRaw.length > NOTE_MAX) {
    return {
      ok: false,
      error: `Note is too long (max ${NOTE_MAX} characters).`,
    };
  }
  const note = noteRaw.length > 0 ? noteRaw : null;

  return { ok: true, value: { programId, effort, note } };
}

/** How many recent sessions the portal surfaces by default. */
export const RECENT_WORKOUTS_LIMIT = 10;

/** Shared read query — kept in one place so the page and tests cannot drift. */
const RECENT_WORKOUTS_SQL = `select wl.id, wl.program_id, p.name as program_name,
        wl.completed_at, wl.effort, wl.note
   from workout_log wl
   join program p on p.id = wl.program_id
  where wl.member_id = $1
  order by wl.completed_at desc
  limit $2`;

/**
 * Log a completed workout session for `memberId` under `identity`. RLS rejects a
 * log for another member or against a program the caller was never assigned, so
 * this returns the inserted row only when the write is legitimately the caller's.
 */
export async function logWorkout(
  identity: Identity,
  memberId: string,
  input: WorkoutLogInput,
): Promise<{ id: string }> {
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `insert into workout_log (tenant_id, member_id, program_id, effort, note)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [identity.tenantId, memberId, input.programId, input.effort, input.note],
    );
    return rows[0];
  });
}

/**
 * The member's most recent logged sessions (default `RECENT_WORKOUTS_LIMIT`).
 * RLS scopes the result to the caller's own logs regardless of `memberId`.
 */
export async function recentWorkoutLogs(
  identity: Identity,
  memberId: string,
  limit: number = RECENT_WORKOUTS_LIMIT,
): Promise<WorkoutLogRow[]> {
  return withTenantContext(
    identity,
    async (c) =>
      (await c.query<WorkoutLogRow>(RECENT_WORKOUTS_SQL, [memberId, limit]))
        .rows,
  );
}
