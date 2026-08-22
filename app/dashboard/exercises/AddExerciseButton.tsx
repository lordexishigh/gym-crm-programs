"use client";

import { useCallback, useState } from "react";
import { Modal } from "@/app/components/Modal";
import { ExerciseLibraryForm } from "./ExerciseLibraryForm";

/**
 * "Add exercise" CTA + its dialog (feedback-2026-08: "put the Add an exercise
 * window as a CTA button, when clicked a popup appears with the info of the
 * existing template").
 *
 * The form previously sat expanded above the library grid, pushing the actual
 * catalog — the thing a trainer comes to this page to read — below the fold.
 * The same form now opens on demand, unchanged in content.
 *
 * Closes on success rather than staying open for repeat entry. The form still
 * resets itself, so "several in a row" costs one extra click, and in exchange
 * the new exercise appearing in the grid behind the dialog becomes the
 * confirmation — a stronger signal than the success line the dialog used to
 * cover up.
 */
export function AddExerciseButton() {
  const [open, setOpen] = useState(false);

  // Stable identity: ExerciseLibraryForm lists this in an effect's dependency
  // array, so an inline closure would re-run the reset on every parent render.
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex shrink-0 items-center gap-2 self-start rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-dark"
      >
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        Add exercise
      </button>

      <Modal
        open={open}
        onClose={close}
        title="Add an exercise"
        description="Add it once and reuse it in any program you build."
      >
        <ExerciseLibraryForm onSuccess={close} />
      </Modal>
    </>
  );
}
