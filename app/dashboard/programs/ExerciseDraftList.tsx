"use client";

import { inputClass, type ExerciseDraft } from "./builder-model";

/**
 * Editable, reorderable list of exercise drafts for the program builder. Fully
 * controlled: the parent owns the draft array and passes mutation callbacks, so
 * this component is pure render + events and independently testable. The
 * sub-inputs are intentionally UNNAMED — only the parent's serialised JSON
 * field reaches the Server Action.
 */
export function ExerciseDraftList({
  exercises,
  onUpdate,
  onMove,
  onRemove,
}: {
  exercises: ExerciseDraft[];
  onUpdate: (
    key: string,
    field: keyof Omit<ExerciseDraft, "key">,
    value: string,
  ) => void;
  /** Swap the exercise at `index` with its neighbour at `index + delta`. */
  onMove: (index: number, delta: number) => void;
  onRemove: (key: string) => void;
}) {
  if (exercises.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
        No exercises yet. Add your first exercise to build the program.
      </div>
    );
  }

  return (
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
                onClick={() => onMove(i, -1)}
                disabled={i === 0}
                aria-label={`Move exercise ${i + 1} up`}
                className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-600 transition hover:bg-slate-100 disabled:opacity-40"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => onMove(i, 1)}
                disabled={i === exercises.length - 1}
                aria-label={`Move exercise ${i + 1} down`}
                className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-600 transition hover:bg-slate-100 disabled:opacity-40"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => onRemove(e.key)}
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
              onChange={(ev) => onUpdate(e.key, "name", ev.target.value)}
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
                onChange={(ev) => onUpdate(e.key, "sets", ev.target.value)}
                className={inputClass}
                placeholder="5"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
              Reps
              <input
                type="text"
                value={e.reps}
                onChange={(ev) => onUpdate(e.key, "reps", ev.target.value)}
                className={inputClass}
                placeholder="5 (or 8-12)"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
              Rest
              <input
                type="text"
                value={e.rest}
                onChange={(ev) => onUpdate(e.key, "rest", ev.target.value)}
                className={inputClass}
                placeholder="90s"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Notes <span className="font-normal text-slate-400">(optional)</span>
            <input
              type="text"
              value={e.notes}
              onChange={(ev) => onUpdate(e.key, "notes", ev.target.value)}
              className={inputClass}
              placeholder="Tempo, cues, or substitutions"
            />
          </label>
        </li>
      ))}
    </ol>
  );
}
