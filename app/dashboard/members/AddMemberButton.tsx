"use client";

import { useCallback, useState } from "react";
import { Modal } from "@/app/components/Modal";
import { MemberForm } from "./MemberForm";
import type { MemberFormState } from "./actions";

/**
 * "Add member" CTA + its dialog (feedback-2026-08: "make all the create X pages
 * into a popup, so the user never leaves the main data").
 *
 * The `/dashboard/members/new` route is deliberately KEPT rather than deleted:
 * it is linked from the Overview quick-actions, it is what the staff-journey
 * e2e drives, and a create screen that only exists as dialog state cannot be
 * linked to or reloaded. This is the roster-page entry point to the same form.
 *
 * The action is passed down from the server page — `createMemberAction` is a
 * Server Action, and this component only ever forwards the reference. On
 * success it `redirect()`s to the new member's detail page, which unmounts the
 * dialog on its own; that redirect is existing, e2e-asserted behaviour and is
 * intentionally left alone.
 */
export function AddMemberButton({
  action,
}: {
  action: (
    state: MemberFormState,
    formData: FormData,
  ) => Promise<MemberFormState>;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-dark"
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
        Add member
      </button>

      <Modal
        open={open}
        onClose={close}
        title="Add member"
        description="Only a name is required — everything else can be filled in later."
      >
        <MemberForm
          action={action}
          submitLabel="Create member"
          onCancel={close}
        />
      </Modal>
    </>
  );
}
