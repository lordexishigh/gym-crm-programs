/**
 * Shared model for the program-builder surface (ProgramBuilder, LibraryPicker,
 * ExerciseDraftList). Pure types + helpers only — no React, no "use client" —
 * so each component stays independently importable and testable.
 */

/** One exercise as edited in the browser; `key` is client-only (React list key). */
export type ExerciseDraft = {
  key: string;
  name: string;
  sets: string;
  reps: string;
  rest: string;
  notes: string;
};

/** Server-shaped exercise values used to pre-fill a draft. */
export type ExerciseDefault = {
  name: string;
  sets: number | null;
  reps: string | null;
  rest: string | null;
  notes: string | null;
};

/** A library exercise the trainer can insert into the program. */
export type LibraryItem = {
  id: string;
  name: string;
  sets: number | null;
  reps: string | null;
  rest: string | null;
  notes: string | null;
};

/** Shared text-input styling for every field on the builder surface. */
export const inputClass =
  "rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand";

/** Map server-shaped defaults to an editable draft row. */
export function toDraft(e: ExerciseDefault, key: string): ExerciseDraft {
  return {
    key,
    name: e.name,
    sets: e.sets === null ? "" : String(e.sets),
    reps: e.reps ?? "",
    rest: e.rest ?? "",
    notes: e.notes ?? "",
  };
}
