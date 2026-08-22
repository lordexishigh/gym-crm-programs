"use client";

import { useActionState, useEffect, useRef } from "react";
import { createLibraryExerciseAction, type LibraryFormState } from "./actions";

const inputClass =
  "rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand";
const labelClass = "flex flex-col gap-1 text-sm font-medium text-slate-700";

/**
 * Add-to-library form (alpha-exercise-library-001/003). The top fields mirror a
 * program's exercise (name, sets, reps, rest, notes); the optional "Reference
 * content" block adds the teaching material members and trainers benefit from —
 * a category, an image link, and how-to instructions, form guidelines, and
 * coaching tips. `useActionState` surfaces validation errors inline; the form is
 * cleared after a successful add so the trainer can enter several in a row.
 *
 * Presentation-free by design: no card chrome and no heading of its own, because
 * it is rendered inside a `<Modal>` (see AddExerciseButton) which supplies both.
 * A second heading here would give the dialog two competing labels.
 */
export function ExerciseLibraryForm({
  onSuccess,
}: {
  /** Called after a successful add — used by the modal host to close itself. */
  onSuccess?: () => void;
} = {}) {
  const [state, formAction, pending] = useActionState<
    LibraryFormState,
    FormData
  >(createLibraryExerciseAction, {});

  const formRef = useRef<HTMLFormElement>(null);

  // Reset the inputs once an add succeeds (state carries a success message).
  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
      onSuccess?.();
    }
  }, [state.success, onSuccess]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          Name
          <input
            type="text"
            name="name"
            required
            className={inputClass}
            placeholder="Back squat"
          />
        </label>
        <label className={labelClass}>
          Category{" "}
          <span className="font-normal text-slate-400">(optional)</span>
          <input
            type="text"
            name="category"
            className={inputClass}
            placeholder="Legs, Push, Pull, Core…"
          />
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className={labelClass}>
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
        <label className={labelClass}>
          Reps
          <input
            type="text"
            name="reps"
            className={inputClass}
            placeholder="5 (or 8-12)"
          />
        </label>
        <label className={labelClass}>
          Rest
          <input
            type="text"
            name="rest"
            className={inputClass}
            placeholder="90s"
          />
        </label>
      </div>

      <label className={labelClass}>
        Notes <span className="font-normal text-slate-400">(optional)</span>
        <input
          type="text"
          name="notes"
          className={inputClass}
          placeholder="Tempo, cues, or substitutions"
        />
      </label>

      <details className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
        <summary className="cursor-pointer select-none text-sm font-medium text-slate-700">
          Reference content{" "}
          <span className="font-normal text-slate-400">
            (image, instructions, guidelines, tips — optional)
          </span>
        </summary>

        <div className="mt-3 flex flex-col gap-3">
          <label className={labelClass}>
            Image URL
            <input
              type="url"
              name="imageUrl"
              className={inputClass}
              placeholder="https://…/back-squat.jpg"
            />
          </label>
          <label className={labelClass}>
            Instructions
            <textarea
              name="instructions"
              rows={4}
              className={inputClass}
              placeholder={"Step-by-step how-to. One step per line."}
            />
          </label>
          <label className={labelClass}>
            Guidelines
            <textarea
              name="guidelines"
              rows={3}
              className={inputClass}
              placeholder="Form & safety: setup, range of motion, what to avoid."
            />
          </label>
          <label className={labelClass}>
            Tips
            <textarea
              name="tips"
              rows={2}
              className={inputClass}
              placeholder="Coaching cues that help members get it right."
            />
          </label>
        </div>
      </details>

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
