import type { PoolClient } from "pg";
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
 * Runs the recent-sessions query on an already-open tenant-scoped client.
 * Exported so `lib/portal.ts` can fold this into a single portal-page
 * transaction (see `loadPortalHome`) instead of opening its own connection.
 */
export async function recentWorkoutLogsQuery(
  client: PoolClient,
  memberId: string,
  limit: number,
): Promise<WorkoutLogRow[]> {
  return (await client.query<WorkoutLogRow>(RECENT_WORKOUTS_SQL, [
    memberId,
    limit,
  ])).rows;
}

/**
 * The most recent logged sessions for `memberId` (default `RECENT_WORKOUTS_LIMIT`).
 *
 * Used by BOTH audiences and secured the same way — by RLS, not by this query:
 *   - member session: `workout_log_member_select` scopes the result to the
 *     caller's own logs, so a crafted `memberId` returns nothing;
 *   - staff session: `workout_log_staff_select` grants read-only visibility into
 *     the staff member's own gym, so `memberId` selects that member's sessions
 *     and a cross-tenant id resolves to no rows (verified in workout-logs-rls).
 */
export async function recentWorkoutLogs(
  identity: Identity,
  memberId: string,
  limit: number = RECENT_WORKOUTS_LIMIT,
): Promise<WorkoutLogRow[]> {
  return withTenantContext(identity, (c) =>
    recentWorkoutLogsQuery(c, memberId, limit),
  );
}

/**
 * The rolling window (in days) used to summarise a member's "recent" training
 * adherence on the staff dashboard (ga-trainer-insights-001).
 */
export const ADHERENCE_WINDOW_DAYS = 30;

/**
 * A member's training-adherence summary for the staff dashboard: how recently
 * and how often they are actually logging the programs a trainer assigned —
 * turning the read-only wedge into a visible feedback loop.
 */
export type MemberAdherence = {
  /** Total sessions ever logged by the member (in this tenant). */
  totalSessions: number;
  /** Sessions logged within `windowDays` (default `ADHERENCE_WINDOW_DAYS`). */
  recentSessions: number;
  /** Most recent session timestamp, or null when the member has never logged. */
  lastCompletedAt: string | null;
};

// Shared adherence aggregate — kept beside the read query so the dashboard view
// and its test cannot drift. `make_interval(days => $2)` keeps the window a
// bound parameter (no string-built SQL). RLS scopes the rows: under a staff
// session this counts only their own gym's logs for `memberId`.
const MEMBER_ADHERENCE_SQL = `select
        count(*)::int                                                          as total_sessions,
        count(*) filter (where completed_at >= now() - make_interval(days => $2))::int as recent_sessions,
        max(completed_at)                                                      as last_completed_at
   from workout_log
  where member_id = $1`;

/**
 * Summarise `memberId`'s workout-logging adherence for staff. RLS makes this
 * read-only and tenant-scoped (a cross-tenant `memberId` yields zeroes/null), so
 * a trainer sees engagement for their own gym's members and no one else's.
 */
export async function memberAdherence(
  identity: Identity,
  memberId: string,
  windowDays: number = ADHERENCE_WINDOW_DAYS,
): Promise<MemberAdherence> {
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<{
      total_sessions: number;
      recent_sessions: number;
      last_completed_at: string | null;
    }>(MEMBER_ADHERENCE_SQL, [memberId, windowDays]);
    const r = rows[0];
    return {
      totalSessions: r?.total_sessions ?? 0,
      recentSessions: r?.recent_sessions ?? 0,
      lastCompletedAt: r?.last_completed_at ?? null,
    };
  });
}

/**
 * How many days of workout history to consider when computing a member's
 * current streak (CRM-IDEAS "Next" #7 — engagement layer). Comfortably covers
 * any realistic streak while keeping the query bounded.
 */
export const STREAK_LOOKBACK_DAYS = 400;

// Raw timestamps only (no ::date cast — pg's `date` type parses in the server's
// local timezone, which would silently misclassify a session logged near
// midnight; `currentStreakDays` below does the calendar-day bucketing itself,
// in UTC, from the full timestamp).
const STREAK_LOG_TIMESTAMPS_SQL = `select completed_at
   from workout_log
  where member_id = $1
    and completed_at >= now() - make_interval(days => $2)
  order by completed_at desc`;

/**
 * Current daily training streak, computed from already-fetched logs. PURE (no
 * DB, no env): counts consecutive UTC calendar days with at least one logged
 * session, walking backward from today. A member who trained yesterday but
 * has not yet logged today's session still sees their streak (it only resets
 * once a full calendar day is missed), so the count doesn't flicker to zero
 * the instant the clock rolls into a new UTC day.
 */
export function currentStreakDays(
  logs: { completed_at: string }[],
  now: Date = new Date(),
): number {
  const days = new Set(
    logs.map((l) => new Date(l.completed_at).toISOString().slice(0, 10)),
  );
  if (days.size === 0) return 0;

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const today = now.toISOString().slice(0, 10);
  let cursor = days.has(today) ? now.getTime() : now.getTime() - ONE_DAY_MS;

  let streak = 0;
  while (days.has(new Date(cursor).toISOString().slice(0, 10))) {
    streak += 1;
    cursor -= ONE_DAY_MS;
  }
  return streak;
}

/**
 * Streak lengths that earn a milestone badge (CRM-IDEAS "Next" #7 — the
 * streak-milestone half; PR-style callouts need per-exercise weight data that
 * does not exist yet, see docs/RISKY-DEFERRED.md item B, so they stay out of
 * scope here). Ascending so `find` can pick the first match in either
 * direction below.
 */
export const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100, 180, 365] as const;

/** The milestone reached exactly today, or null if `days` isn't one. */
export function streakMilestoneReached(days: number): number | null {
  return STREAK_MILESTONES.find((m) => m === days) ?? null;
}

/** The next milestone still ahead, or null once the longest has passed. */
export function nextStreakMilestone(days: number): number | null {
  return STREAK_MILESTONES.find((m) => m > days) ?? null;
}

/**
 * A member's current streak of consecutive days with a logged workout. Reuses
 * the same RLS as `recentWorkoutLogs` (`workout_log_member_select` /
 * `workout_log_staff_select`) — a cross-tenant or another member's id yields 0,
 * not an error.
 */
/** Runs the streak query on an already-open tenant-scoped client — see `recentWorkoutLogsQuery`. */
export async function workoutStreakDaysQuery(
  client: PoolClient,
  memberId: string,
  lookbackDays: number,
): Promise<number> {
  const { rows } = await client.query<{ completed_at: string }>(
    STREAK_LOG_TIMESTAMPS_SQL,
    [memberId, lookbackDays],
  );
  return currentStreakDays(rows);
}

export async function workoutStreakDays(
  identity: Identity,
  memberId: string,
  lookbackDays: number = STREAK_LOOKBACK_DAYS,
): Promise<number> {
  return withTenantContext(identity, (c) =>
    workoutStreakDaysQuery(c, memberId, lookbackDays),
  );
}

/**
 * Per-member engagement summary used by the staff roster at-a-glance signal
 * (review-hardening-roster-engagement-001 / ga-trainer-insights-002). The roster
 * computes these two values for every listed member in ONE aggregate join (see
 * `rosterListSql` in `lib/members.ts`) — never a per-row query — so the indicator
 * adds no N+1 cost. RLS (`workout_log_staff_select`) scopes the underlying rows
 * to the staff member's own gym, so a member from another tenant contributes
 * nothing to these counts.
 */
export type RosterEngagement = {
  /** Sessions this member logged inside the adherence window. */
  recentSessions: number;
  /** Most recent session timestamp ever, or null if the member never logged. */
  lastCompletedAt: string | null;
};

/**
 * How engaged a member is, for the roster badge. Kept PURE so the view and its
 * test cannot drift on how a member is classified.
 *
 *   - "active"  — logged at least one session inside the window.
 *   - "at-risk" — has logged before, but nothing inside the window: the member
 *                 went quiet. This is the actionable churn signal a trainer wants
 *                 to catch without opening each profile.
 *   - "none"    — never logged a session (e.g. just added, or no program yet).
 *                 Deliberately NOT flagged as at-risk, so the signal stays focused
 *                 on members who started training and then stopped.
 */
export type EngagementLevel = "active" | "at-risk" | "none";

export function memberEngagementLevel(e: RosterEngagement): EngagementLevel {
  if (e.recentSessions > 0) return "active";
  if (e.lastCompletedAt) return "at-risk";
  return "none";
}
