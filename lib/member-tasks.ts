import { withTenantContext, type Identity } from "./db";

/**
 * Trainer follow-up tasks / reminders on a member (CRM-IDEAS "Apply now" #5).
 *
 * A lightweight, staff-only reminder ("check in with X by Friday") a trainer
 * leaves on a member, closing the loop after the roster at-risk signal
 * (`memberEngagementLevel`, lib/workout-logs.ts) flags someone. Validation is a
 * PURE function (no DB, no env), mirroring `validateWorkoutLogInput` /
 * `validateMemberInput`. The DB still enforces the hard invariant (tasks live
 * only in the caller's own gym) via RLS (`member_task_staff_all`, migration
 * 0013) — members can never read or write this table at all.
 */

export type MemberTaskRow = {
  id: string;
  title: string;
  due_at: string | null;
  completed_at: string | null;
  created_at: string;
  /** The staff author's name, or null when unknown / since-removed. */
  created_by_name: string | null;
};

export type MemberTaskInput = {
  title: string;
  /** ISO timestamp, or null when the task has no due date. */
  dueAt: string | null;
};

export type MemberTaskValidationResult =
  | { ok: true; value: MemberTaskInput }
  | { ok: false; error: string };

const TITLE_MAX = 300;

/**
 * Validate + normalise raw form values into a `MemberTaskInput`.
 *
 * Rules:
 *   - title is REQUIRED, trimmed, and capped at a sane length.
 *   - dueAt is optional; when present it must parse as a valid date/datetime.
 */
export function validateMemberTaskInput(raw: {
  title?: unknown;
  dueAt?: unknown;
}): MemberTaskValidationResult {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) {
    return { ok: false, error: "Describe what needs following up." };
  }
  if (title.length > TITLE_MAX) {
    return {
      ok: false,
      error: `Task is too long (max ${TITLE_MAX} characters).`,
    };
  }

  const dueRaw = typeof raw.dueAt === "string" ? raw.dueAt.trim() : "";
  let dueAt: string | null = null;
  if (dueRaw !== "") {
    const d = new Date(dueRaw);
    if (Number.isNaN(d.getTime())) {
      return { ok: false, error: "That due date is not valid." };
    }
    dueAt = d.toISOString();
  }

  return { ok: true, value: { title, dueAt } };
}

/** Shared read query — kept in one place so the page and tests cannot drift. */
export const MEMBER_TASKS_SQL = `select t.id, t.title, t.due_at, t.completed_at, t.created_at,
        u.full_name as created_by_name
   from member_task t
   left join users u on u.id = t.created_by
  where t.member_id = $1
  order by (t.completed_at is not null), t.due_at asc nulls last, t.created_at desc`;

/**
 * A member's follow-up tasks, open first, ordered by due date. RLS constrains
 * the result to the caller's own gym regardless of the `memberId` argument, and
 * a member session sees nothing at all (`member_task_staff_all` is staff-only).
 */
export async function memberTasks(
  identity: Identity,
  memberId: string,
): Promise<MemberTaskRow[]> {
  return withTenantContext(
    identity,
    async (c) =>
      (await c.query<MemberTaskRow>(MEMBER_TASKS_SQL, [memberId])).rows,
  );
}

/** Create a follow-up task for `memberId`, authored by `createdBy` (users.id, nullable). */
export async function createMemberTask(
  identity: Identity,
  memberId: string,
  input: MemberTaskInput,
  createdBy: string | null,
): Promise<{ id: string }> {
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `insert into member_task (tenant_id, member_id, title, due_at, created_by)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [identity.tenantId, memberId, input.title, input.dueAt, createdBy],
    );
    return rows[0];
  });
}

/**
 * Mark a task done. Only a still-open task matches (idempotent: completing an
 * already-done task is a no-op). Returns the number of rows updated — 0 means
 * the task was not found, cross-tenant, or already completed.
 */
export async function completeMemberTask(
  identity: Identity,
  taskId: string,
): Promise<number> {
  return withTenantContext(identity, async (c) => {
    const res = await c.query(
      "update member_task set completed_at = now() where id = $1 and completed_at is null",
      [taskId],
    );
    return res.rowCount ?? 0;
  });
}

// `taskUrgency` (the "overdue"/"due today" classifier) lives in
// app/dashboard/members/task-model.ts, NOT here — it is used by the
// client-side `MemberTasks` component, and this module transitively imports
// `lib/db` (pg → Node builtins), which cannot be bundled for the browser. See
// that file's header for the split rationale (mirrors
// app/dashboard/programs/builder-model.ts).
