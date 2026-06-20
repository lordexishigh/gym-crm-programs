"use client";

import { useActionState, useEffect, useRef } from "react";
import { createLibraryExerciseAction, type LibraryFormState } from "./actions";

const inputClass =
  "rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand";

/**
 * Add-to-library form (alpha-exercise-library-001). Fields mirror a program's
 * exercise (name, sets, reps, rest, notes). `useActionState` surfaces validation
 * errors inline; the form is cleared after a successful add so the trainer can
 * quickly enter several exercises in a row.
 */
export function ExerciseLibraryForm() {
  const [state, formAction, pending] = useActionState<
    LibraryFormState,
    FormData
  >(createLibraryExerciseAction, {});

  const formRef = useRef<HTMLFormElement>(null);

  // Reset the inputs once an add succeeds (state carries a success message).
  useEffect(() => {
    if (state.success) formRef.current?.reset();
  }, [state.success]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4"
    >
      <h2 className="text-base font-semibold text-slate-900">Add an exercise</h2>

      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Name
        <input
          type="text"
          name="name"
          required
          className={inputClass}
          placeholder="Back squat"
        />
      </label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Sets
          <input
            type="number"
            name="sets"
            min={0}
            inputMode="numeric"
            className={inputClass}
            placeholder="5"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Reps
          <input
            type="text"
            name="reps"
            className={inputClass}
            placeholder="5 (or 8-12)"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Rest
          <input
            type="text"
            name="rest"
            className={inputClass}
            placeholder="90s"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Notes <span className="font-normal text-slate-400">(optional)</span>
        <input
          type="text"
          name="notes"
          className={inputClass}
          placeholder="Tempo, cues, or substitutions"
        />
      </label>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p role="status" className="text-sm text-green-700">
          {state.success}
        </p>
      ) : null}

      <div>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-base font-medium text-white transition hover:bg-brand-dark disabled:opacity-60"
        >
          {pending ? "Adding…" : "Add to library"}
        </button>
      </div>
    </form>
  );
}
