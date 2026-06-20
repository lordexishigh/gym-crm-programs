"use client";

import { useActionState } from "react";
import Link from "next/link";
import type { MemberFormState } from "./actions";

type Action = (
  state: MemberFormState,
  formData: FormData,
) => Promise<MemberFormState>;

type Defaults = {
  id?: string;
  fullName?: string;
  email?: string;
  status?: "active" | "inactive";
};

/**
 * Shared create/edit member form (mvp-member-management-001).
 *
 * Wraps a Server Action via `useActionState` so server-side validation errors
 * are surfaced inline without losing the entered values. `required` on the name
 * input gives a fast client-side guard; the action re-validates authoritatively.
 */
export function MemberForm({
  action,
  defaults = {},
  submitLabel,
}: {
  action: Action;
  defaults?: Defaults;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState<MemberFormState, FormData>(
    action,
    {},
  );

  return (
    <form action={formAction} className="flex max-w-lg flex-col gap-4">
      {defaults.id ? (
        <input type="hidden" name="id" value={defaults.id} />
      ) : null}

      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Full name
        <input
          type="text"
          name="fullName"
          required
          defaultValue={defaults.fullName ?? ""}
          className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          placeholder="Jane Athlete"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Email <span className="font-normal text-slate-400">(required to send an invite)</span>
        <input
          type="email"
          name="email"
          defaultValue={defaults.email ?? ""}
          className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          placeholder="jane@example.com"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Status
        <select
          name="status"
          defaultValue={defaults.status ?? "active"}
          className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        >
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </label>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-base font-medium text-white transition hover:bg-brand-dark disabled:opacity-60"
        >
          {pending ? "Saving…" : submitLabel}
        </button>
        <Link
          href="/dashboard/members"
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
