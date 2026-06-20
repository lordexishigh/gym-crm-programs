"use client";

import { useActionState, useRef, useState } from "react";
import Link from "next/link";
import type { ProgramFormState } from "./actions";

type Action = (
  state: ProgramFormState,
  formData: FormData,
) => Promise<ProgramFormState>;

/** One exercise as edited in the browser; `key` is client-only (React list key). */
type ExerciseDraft = {
  key: string;
  name: string;
  sets: string;
  reps: string;
  rest: string;
  notes: string;
};

type ExerciseDefault = {
  name: string;
  sets: number | null;
  reps: string | null;
  rest: string | null;
  notes: string | null;
};

type Defaults = {
  id?: string;
  name?: string;
  description?: string;
  exercises?: ExerciseDefault[];
};

const inputClass =
  "rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand";

function toDraft(e: ExerciseDefault, key: string): ExerciseDraft {
  return {
    key,
    name: e.name,
    sets: e.sets === null ? "" : String(e.sets),
    reps: e.reps ?? "",
    rest: e.rest ?? "",
    notes: e.notes ?? "",
  };
}

/**
 * Trainer-facing program builder (mvp-program-002). Name a program and
 * add/edit/reorder/remove exercises with their sets, reps, rest, and notes.
 *
 * Exercises are dynamic, so they live in React state and are serialised into a
 * single hidden `exercises` field on submit (the sub-inputs are intentionally
 * unnamed so only the JSON reaches the Server Action, which re-validates it).
 * Wrapping the Server Action via `useActionState` surfaces validation errors
 * inline without losing the entered values.
 */
export function ProgramBuilder({
  action,
  defaults = {},
  submitLabel,
}: {
  action: Action;
  defaults?: Defaults;
  submitLabel: string;
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
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-base font-semibold text-slate-900">Exercises</h2>
          <button
            type="button"
            onClick={addExercise}
            className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
          >
            + Add exercise
          </button>
        </div>

        {exercises.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
            No exercises yet. Add your first exercise to build the program.
          </div>
        ) : (
          <ol className="flex flex-col gap-3">
            {exercises.map((e, i) => (
              <li
                key={e.key}
                className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-slate-500">
                    Exercise {i + 1}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      aria-label={`Move exercise ${i + 1} up`}
                      className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-600 transition hover:bg-slate-100 disabled:opacity-40"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => move(i, 1)}
                      disabled={i === exercises.length - 1}
                      aria-label={`Move exercise ${i + 1} down`}
                      className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-600 transition hover:bg-slate-100 disabled:opacity-40"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => removeExercise(e.key)}
                      aria-label={`Remove exercise ${i + 1}`}
                      className="rounded-md border border-slate-300 px-2 py-1 text-sm font-medium text-red-600 transition hover:bg-red-50"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
                  Name
                  <input
                    type="text"
                    value={e.name}
                    onChange={(ev) =>
                      updateExercise(e.key, "name", ev.target.value)
                    }
                    className={inputClass}
                    placeholder="Back squat"
                  />
                </label>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
                    Sets
                    <input
                      type="number"
                      min={0}
                      inputMode="numeric"
                      value={e.sets}
                      onChange={(ev) =>
                        updateExercise(e.key, "sets", ev.target.value)
                      }
                      className={inputClass}
                      placeholder="5"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
                    Reps
                    <input
                      type="text"
                      value={e.reps}
                      onChange={(ev) =>
                        updateExercise(e.key, "reps", ev.target.value)
                      }
                      className={inputClass}
                      placeholder="5 (or 8-12)"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
                    Rest
                    <input
                      type="text"
                      value={e.rest}
                      onChange={(ev) =>
                        updateExercise(e.key, "rest", ev.target.value)
                      }
                      className={inputClass}
                      placeholder="90s"
                    />
                  </label>
                </div>

                <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
                  Notes{" "}
                  <span className="font-normal text-slate-400">(optional)</span>
                  <input
                    type="text"
                    value={e.notes}
                    onChange={(ev) =>
                      updateExercise(e.key, "notes", ev.target.value)
                    }
                    className={inputClass}
                    placeholder="Tempo, cues, or substitutions"
                  />
                </label>
              </li>
            ))}
          </ol>
        )}
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
