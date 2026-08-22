"use client";

import { useActionState, useEffect, useRef } from "react";
import { createClassAction, type ClassFormState } from "./actions";

const initialState: ClassFormState = {};

/**
 * Staff form to schedule a new class.
 *
 * Presentation-free (no card, no heading): it is rendered inside a `<Modal>`
 * via ScheduleClassButton, which supplies both. Stacked rather than the wrapping
 * horizontal bar it used to be, because a dialog is narrow and a 5-field row
 * reflows into ragged columns at that width.
 */
export function ClassForm({
  onSuccess,
}: {
  /** Called after a successful schedule — used by the modal host to close. */
  onSuccess?: () => void;
} = {}) {
  const [state, formAction, pending] = useActionState(createClassAction, initialState);

  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
      onSuccess?.();
    }
  }, [state.success, onSuccess]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-4">
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

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Duration (min)
          <input
            type="number"
            name="durationMinutes"
            min="1"
            max="600"
            defaultValue={60}
            required
            className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
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
            className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          />
        </label>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
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
