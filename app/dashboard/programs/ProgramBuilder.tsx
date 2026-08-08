"use client";

import { useActionState, useRef, useState } from "react";
import Link from "next/link";
import type { ProgramFormState } from "./actions";
import {
  inputClass,
  toDraft,
  type ExerciseDefault,
  type ExerciseDraft,
  type LibraryItem,
} from "./builder-model";
import { LibraryPicker } from "./LibraryPicker";
import { ExerciseDraftList } from "./ExerciseDraftList";

type Action = (
  state: ProgramFormState,
  formData: FormData,
) => Promise<ProgramFormState>;

type Defaults = {
  id?: string;
  name?: string;
  description?: string;
  exercises?: ExerciseDefault[];
};

/**
 * Trainer-facing program builder (mvp-program-002). The library picker lives in
 * `LibraryPicker` and the editable rows in `ExerciseDraftList`; this component
 * owns only the draft array, the form fields, and submission.
 *
 * Drafts live in React state and are serialised into a single hidden
 * `exercises` field on submit (the row sub-inputs are intentionally unnamed so
 * only the JSON reaches the Server Action, which re-validates it).
 * `useActionState` surfaces validation errors inline without losing input.
 */
export function ProgramBuilder({
  action,
  defaults = {},
  submitLabel,
  library = [],
}: {
  action: Action;
  defaults?: Defaults;
  submitLabel: string;
  /** The gym's exercise library, selectable to insert into the program. */
  library?: LibraryItem[];
}) {
  const [state, formAction, pending] = useActionState<
    ProgramFormState,
    FormData
  >(action, {});

  // Stable client keys without Date/random: a monotonically increasing counter.
  const nextKey = useRef(0);
  const makeKey = () => `ex-${nextKey.current++}`;

  const [exercises, setExercises] = useState<ExerciseDraft[]>(() =>
    (defaults.exercises ?? []).map((e) => toDraft(e, makeKey())),
  );

  /** Append the chosen library exercise as a new, editable draft. */
  function addFromLibrary(item: LibraryItem) {
    setExercises((prev) => [
      ...prev,
      toDraft(
        {
          name: item.name,
          sets: item.sets,
          reps: item.reps,
          rest: item.rest,
          notes: item.notes,
        },
        makeKey(),
      ),
    ]);
  }

  function addExercise() {
    setExercises((prev) => [
      ...prev,
      { key: makeKey(), name: "", sets: "", reps: "", rest: "", notes: "" },
    ]);
  }

  function removeExercise(key: string) {
    setExercises((prev) => prev.filter((e) => e.key !== key));
  }

  function updateExercise(
    key: string,
    field: keyof Omit<ExerciseDraft, "key">,
    value: string,
  ) {
    setExercises((prev) =>
      prev.map((e) => (e.key === key ? { ...e, [field]: value } : e)),
    );
  }

  function move(index: number, delta: number) {
    setExercises((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  // Serialised payload the Server Action parses + re-validates.
  const serialized = JSON.stringify(
    exercises.map((e) => ({
      name: e.name,
      sets: e.sets,
      reps: e.reps,
      rest: e.rest,
      notes: e.notes,
    })),
  );

  return (
    <form action={formAction} className="flex flex-col gap-6">
      {defaults.id ? (
        <input type="hidden" name="id" value={defaults.id} />
      ) : null}
      <input type="hidden" name="exercises" value={serialized} />

      <div className="flex max-w-lg flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Program name
          <input
            type="text"
            name="name"
            required
            defaultValue={defaults.name ?? ""}
            className={inputClass}
            placeholder="Beginner Strength — Phase 1"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Description{" "}
          <span className="font-normal text-slate-400">(optional)</span>
          <textarea
            name="description"
            rows={2}
            defaultValue={defaults.description ?? ""}
            className={inputClass}
            placeholder="Goals, schedule, or any notes for the member."
          />
        </label>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">Exercises</h2>
          <div className="flex flex-wrap items-center gap-2">
            <LibraryPicker library={library} onInsert={addFromLibrary} />
            <button
              type="button"
              onClick={addExercise}
              className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              + Add exercise
            </button>
          </div>
        </div>

        <ExerciseDraftList
          exercises={exercises}
          onUpdate={updateExercise}
          onMove={move}
          onRemove={removeExercise}
        />
      </div>

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
          href="/dashboard/programs"
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
