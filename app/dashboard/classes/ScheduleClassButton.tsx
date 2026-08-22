"use client";

import { useCallback, useState } from "react";
import { Modal } from "@/app/components/Modal";
import { ClassForm } from "./ClassForm";

/**
 * "Schedule a class" CTA + its dialog (feedback-2026-08: "putting window into
 * button for classes page as well").
 *
 * Same move as AddExerciseButton: the scheduling form used to sit permanently
 * above the calendar, so the upcoming classes — the reason to open this page —
 * started halfway down. Closes on success; the new class appearing in the list
 * behind is the confirmation.
 */
export function ScheduleClassButton() {
  const [open, setOpen] = useState(false);
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
        Schedule a class
      </button>

      <Modal
        open={open}
        onClose={close}
        title="Schedule a class"
        description="Members book it from the portal once it is on the calendar."
      >
        <ClassForm onSuccess={close} />
      </Modal>
    </>
  );
}
