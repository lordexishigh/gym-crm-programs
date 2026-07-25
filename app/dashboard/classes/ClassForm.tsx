"use client";

import { useActionState } from "react";
import { createClassAction, type ClassFormState } from "./actions";

const initialState: ClassFormState = {};

/** Staff form to schedule a new class. */
export function ClassForm() {
  const [state, formAction, pending] = useActionState(createClassAction, initialState);

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:flex-wrap sm:items-end"
    >
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Class name
        <input
          type="text"
          name="name"
          required
          className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          placeholder="Morning CrossFit"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Instructor <span className="font-normal text-slate-400">(optional)</span>
        <input
          type="text"
          name="instructorName"
          className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          placeholder="Coach Maria"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Starts at
        <input
          type="datetime-local"
          name="startsAt"
          required
          className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Duration (min)
        <input
          type="number"
          name="durationMinutes"
          min="1"
          max="600"
          defaultValue={60}
          required
          className="w-28 rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Capacity
        <input
          type="number"
          name="capacity"
          min="1"
          max="1000"
          defaultValue={12}
          required
          className="w-24 rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />
      </label>

      {state.error ? (
        <p role="alert" className="w-full text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="w-full text-sm text-emerald-700">{state.success}</p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-dark disabled:opacity-60"
      >
        {pending ? "Saving…" : "Schedule class"}
      </button>
    </form>
  );
}
