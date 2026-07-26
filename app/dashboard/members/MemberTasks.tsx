"use client";

import { useActionState } from "react";
import type { MemberTaskRow } from "../../../lib/member-tasks";
import { taskUrgency } from "./task-model";
import {
  createMemberTaskAction,
  completeMemberTaskAction,
  type MemberTaskState,
} from "./actions";

/**
 * Follow-up tasks / reminders on a member (CRM-IDEAS "Apply now" #5).
 *
 * A trainer can leave a "check in with X by Friday" note on a member, and mark
 * it done once handled. Only open tasks are listed by default — this is a
 * working queue, not a permanent history like `StatusHistory`. Overdue and
 * due-today tasks are called out so the loop the roster at-risk badge opens
 * (`memberEngagementLevel`) has a visible next step.
 */
function formatDue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

const URGENCY_STYLE: Record<string, string> = {
  overdue: "bg-red-50 text-red-700",
  "due-today": "bg-amber-50 text-amber-700",
  upcoming: "bg-slate-100 text-slate-600",
  none: "bg-slate-100 text-slate-500",
};

const URGENCY_LABEL: Record<string, string> = {
  overdue: "Overdue",
  "due-today": "Due today",
  upcoming: "Upcoming",
  none: "No due date",
};

function CompleteButton({
  taskId,
  memberId,
}: {
  taskId: string;
  memberId: string;
}) {
  const [state, action, pending] = useActionState<MemberTaskState, FormData>(
    completeMemberTaskAction,
    {},
  );
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="memberId" value={memberId} />
      <button
        type="submit"
        disabled={pending}
        className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
      >
        {pending ? "Marking done…" : "Mark done"}
      </button>
      {state.error ? (
        <p role="alert" className="text-xs text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function MemberTasks({
  memberId,
  tasks,
}: {
  memberId: string;
  tasks: MemberTaskRow[];
}) {
  const [createState, createAction, creating] = useActionState<
    MemberTaskState,
    FormData
  >(createMemberTaskAction, {});

  const open = tasks.filter((t) => !t.completed_at);
  const doneCount = tasks.length - open.length;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-slate-900">Follow-up tasks</h2>

      <form
        action={createAction}
        className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-end"
      >
        <input type="hidden" name="memberId" value={memberId} />
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Task
          </span>
          <input
            type="text"
            name="title"
            required
            placeholder="e.g. Check in about missed sessions"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Due (optional)
          </span>
          <input
            type="date"
            name="dueAt"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={creating}
          className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-dark disabled:opacity-60"
        >
          {creating ? "Adding…" : "Add task"}
        </button>
      </form>
      {createState.error ? (
        <p role="alert" className="text-sm text-red-600">
          {createState.error}
        </p>
      ) : null}

      {open.length === 0 ? (
        <p className="text-sm text-slate-500">
          No open follow-ups
          {doneCount > 0 ? ` (${doneCount} completed)` : ""}.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {open.map((task) => {
            const urgency = taskUrgency(task);
            return (
              <li
                key={task.id}
                className="flex items-center justify-between gap-4 px-4 py-3 text-sm"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="truncate font-medium text-slate-900">
                    {task.title}
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span
                      className={`rounded-full px-2 py-0.5 font-medium ${URGENCY_STYLE[urgency]}`}
                    >
                      {URGENCY_LABEL[urgency]}
                      {task.due_at ? ` · ${formatDue(task.due_at)}` : ""}
                    </span>
                    {task.created_by_name ? `by ${task.created_by_name}` : null}
                  </span>
                </div>
                <CompleteButton taskId={task.id} memberId={memberId} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
