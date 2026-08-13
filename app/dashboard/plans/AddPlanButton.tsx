"use client";

import { useCallback, useState } from "react";
import { Modal } from "@/app/components/Modal";
import { PlanForm } from "./PlanForm";

/**
 * "Add plan" CTA + its dialog (feedback-2026-08). Same pattern as the exercise
 * and class dialogs — the owner-only plans page had its create form pinned
 * above the plan list.
 */
export function AddPlanButton() {
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
        Add plan
      </button>

      <Modal
        open={open}
        onClose={close}
        title="Add a membership plan"
        description="Plans are what members are billed against."
      >
        <PlanForm onSuccess={close} />
      </Modal>
    </>
  );
}
