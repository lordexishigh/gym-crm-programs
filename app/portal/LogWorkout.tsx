"use client";

import { useActionState } from "react";
import { logWorkoutAction, type LogWorkoutState } from "./actions";

/**
 * "Log a workout" control for the member portal (Phase GA — ga-engagement-001).
 *
 * The portal's first interactive affordance. Deliberately kept OUT of
 * `ProgramView` (whose test asserts that view has no forms/inputs/buttons): this
 * is the one place the read-only program rendering and the write path meet, and
 * keeping them in separate components preserves that guarantee.
 *
 * Mobile-first: base text size avoids iOS zoom-on-focus, controls are full-width
 * with large tap targets, and every control has hover/focus-visible/disabled
 * states via the shared `brand` token.
 */
const initialState: LogWorkoutState = {};

export type ActiveProgramOption = { id: string; name: string };

export function LogWorkout({
  programs,
}: {
  programs: ActiveProgramOption[];
}) {
  const [state, formAction, pending] = useActionState(
    logWorkoutAction,
    initialState,
  );

  // No active program → nothing to log against; render nothing.
  if (programs.length === 0) return null;

  const single = programs.length === 1 ? programs[0] : null;

  return (
    <section className="mt-10 flex flex-col gap-3 border-t border-slate-200 pt-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-slate-900">Log a workout</h2>
        <p className="text-sm text-slate-600">
          Done training today? Log it so your trainer can see your progress.
        </p>
      </div>

      <form action={formAction} className="flex flex-col gap-4">
        {single ? (
          <input type="hidden" name="programId" value={single.id} />
        ) : (
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Program
            <select
              name="programId"
              required
              defaultValue=""
              className="rounded-lg border border-slate-300 bg-white px-3 py-3 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            >
              <option value="" disabled>
                Which program did you train?
              </option>
              {programs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Effort (optional)
          <select
            name="effort"
            defaultValue=""
            className="rounded-lg border border-slate-300 bg-white px-3 py-3 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          >
            <option value="">How hard was it? (RPE 1–10)</option>
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n} / 10
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Note (optional)
          <textarea
            name="note"
            rows={2}
            maxLength={1000}
            placeholder="How did the session go?"
            className="rounded-lg border border-slate-300 px-3 py-3 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          />
        </label>

        {state.error ? (
          <p role="alert" className="text-sm text-red-600">
            {state.error}
          </p>
        ) : null}
        {state.ok ? (
          <p role="status" className="text-sm font-medium text-brand">
            Workout logged — nice work!
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-3 text-base font-medium text-white transition hover:bg-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:opacity-60"
        >
          {pending ? "Logging…" : "Log workout"}
        </button>
      </form>
    </section>
  );
}
