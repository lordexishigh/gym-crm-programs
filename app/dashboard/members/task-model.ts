import type { MemberTaskRow } from "../../../lib/member-tasks";

/**
 * Pure task-urgency classification for the follow-up tasks panel
 * (CRM-IDEAS "Apply now" #5).
 *
 * Colocated with `MemberTasks` (a "use client" component) rather than in
 * `lib/member-tasks.ts`: that module also exports DB functions that import
 * `lib/db` (pg → Node's `dns`/`net`/`tls`), which cannot be bundled for the
 * browser. Keeping this pure classifier in its own no-DB file lets the client
 * component import a real function (not just types) without pulling the
 * server-only module into the client bundle — the same split as
 * `app/dashboard/programs/builder-model.ts`. `MemberTaskRow` itself is still
 * imported `type`-only from `lib/member-tasks.ts`, which TypeScript erases
 * entirely at compile time (no runtime import), so the canonical row shape
 * lives in one place next to the SQL that produces it.
 */
export type TaskUrgency = "overdue" | "due-today" | "upcoming" | "none" | "done";

/**
 * Classify a task's urgency. Kept PURE so the view and its test cannot drift on
 * what counts as "overdue" vs "due today" — mirrors `memberEngagementLevel`
 * (lib/workout-logs.ts). "Due today" compares calendar dates in UTC, not a
 * rolling 24h window, so a task due any time today reads as due today
 * regardless of what hour it is checked.
 */
export function taskUrgency(
  task: Pick<MemberTaskRow, "due_at" | "completed_at">,
  now: Date = new Date(),
): TaskUrgency {
  if (task.completed_at) return "done";
  if (!task.due_at) return "none";

  const due = new Date(task.due_at);
  const dueDay = due.toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  if (dueDay < today) return "overdue";
  if (dueDay === today) return "due-today";
  return "upcoming";
}
