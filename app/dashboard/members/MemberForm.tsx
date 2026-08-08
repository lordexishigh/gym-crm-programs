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
  phone?: string;
  status?: "active" | "inactive";
  notes?: string;
  photoUrl?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  membershipStatus?: "active" | "expired" | "frozen" | "cancelled";
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
        Phone <span className="font-normal text-slate-400">(optional)</span>
        <input
          type="tel"
          name="phone"
          defaultValue={defaults.phone ?? ""}
          className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          placeholder="+357 99 123456"
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

      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Membership status
        <select
          name="membershipStatus"
          defaultValue={defaults.membershipStatus ?? "active"}
          className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        >
          <option value="active">Active</option>
          <option value="expired">Expired</option>
          <option value="frozen">Frozen</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </label>

      {/* Kept alongside the uploader (MemberPhotoPanel) for rosters imported
          from another system, where the picture is already hosted elsewhere. An
          uploaded photo takes precedence — see `memberAvatarSrc`. */}
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Photo URL{" "}
        <span className="font-normal text-slate-400">
          (optional — only if the photo is hosted elsewhere; uploading one wins)
        </span>
        <input
          type="url"
          name="photoUrl"
          defaultValue={defaults.photoUrl ?? ""}
          className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          placeholder="https://…/photo.jpg"
        />
      </label>

      <fieldset className="flex flex-col gap-3 rounded-lg border border-slate-200 p-3">
        <legend className="px-1 text-xs font-medium uppercase tracking-wide text-slate-400">
          Emergency contact
        </legend>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Name <span className="font-normal text-slate-400">(optional)</span>
          <input
            type="text"
            name="emergencyContactName"
            defaultValue={defaults.emergencyContactName ?? ""}
            className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            placeholder="Next of kin"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Phone <span className="font-normal text-slate-400">(optional)</span>
          <input
            type="tel"
            name="emergencyContactPhone"
            defaultValue={defaults.emergencyContactPhone ?? ""}
            className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            placeholder="+357 99 123456"
          />
        </label>
      </fieldset>

      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Notes <span className="font-normal text-slate-400">(optional)</span>
        <textarea
          name="notes"
          rows={4}
          defaultValue={defaults.notes ?? ""}
          className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          placeholder="Injuries, goals, preferences…"
        />
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
