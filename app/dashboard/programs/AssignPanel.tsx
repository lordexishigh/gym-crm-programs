"use client";

import { useActionState } from "react";
import {
  assignProgramAction,
  unassignProgramAction,
  type AssignState,
} from "./actions";
import { StuckPendingNotice } from "../../components/StuckPendingNotice";

type MemberOption = { id: string; full_name: string };
type Assignment = {
  member_id: string;
  full_name: string;
  assigned_at: string;
};

/**
 * Assign-a-program control on the program detail page (mvp-program-004).
 *
 * The member picker is populated from the server-loaded, RLS-scoped member list
 * (current gym only). Current assignments are listed so staff can confirm the
 * assignment after saving and remove one to replace it.
 */
export function AssignPanel({
  programId,
  members,
  assignments,
}: {
  programId: string;
  members: MemberOption[];
  assignments: Assignment[];
}) {
  const [state, formAction, pending] = useActionState<AssignState, FormData>(
    assignProgramAction,
    {},
  );
  const [removeState, removeAction] = useActionState<AssignState, FormData>(
    unassignProgramAction,
    {},
  );

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-slate-900">
          Assign to members
        </h2>
        <p className="text-sm text-slate-600">
          Pick a member from your gym to give them this program.
        </p>
      </div>

      {members.length === 0 ? (
        <p className="text-sm text-slate-500">
          No members yet. Add a member first, then assign this program.
        </p>
      ) : (
        <form action={formAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="programId" value={programId} />
          <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-slate-700">
            Member
            <select
              name="memberId"
              defaultValue=""
              required
              className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            >
              <option value="" disabled>
                Select a member…
              </option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-dark disabled:opacity-60"
          >
            {pending ? "Assigning…" : "Assign"}
          </button>
        </form>
      )}

      <StuckPendingNotice pending={pending} message="Still assigning?" />

      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="text-sm text-emerald-700">{state.success}</p>
      ) : null}
      {removeState.error ? (
        <p role="alert" className="text-sm text-red-600">
          {removeState.error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-slate-700">
          Currently assigned
        </h3>
        {assignments.length === 0 ? (
          <p className="text-sm text-slate-500">
            Not assigned to anyone yet.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200">
            {assignments.map((a) => (
              <li
                key={a.member_id}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-slate-900">
                    {a.full_name}
                  </span>
                  <span className="text-xs text-slate-500">
                    Assigned {new Date(a.assigned_at).toLocaleDateString()}
                  </span>
                </div>
                <form action={removeAction}>
                  <input type="hidden" name="programId" value={programId} />
                  <input type="hidden" name="memberId" value={a.member_id} />
                  <button
                    type="submit"
                    className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50"
                  >
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
