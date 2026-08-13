"use client";

import { useCallback, useState } from "react";
import { Modal } from "@/app/components/Modal";
import { ProgramBuilder } from "./ProgramBuilder";
import type { LibraryItem } from "./builder-model";
import type { ProgramFormState } from "./actions";

/**
 * "New program" CTA + its dialog (feedback-2026-08).
 *
 * The builder is the heaviest surface to put in a dialog — a name/description
 * pair, a searchable library picker, and a reorderable draft list — so it opens
 * at the wide size and relies on the Modal's scrolling body. The picker uses a
 * native `<select>`, which the browser renders in its own layer, so the dropdown
 * is not clipped by that scroll container.
 *
 * `/dashboard/programs/new` is KEPT, like the member route: it is deep-linkable,
 * reloadable, and the builder is long enough that a full page is genuinely the
 * better surface on a phone. This is the list-page entry point to the same form.
 *
 * `createProgramAction` redirects to the new program's detail page on success,
 * which unmounts the dialog on its own — that redirect is existing, e2e-asserted
 * behaviour and is intentionally left alone.
 */
export function AddProgramButton({
  action,
  library,
}: {
  action: (
    state: ProgramFormState,
    formData: FormData,
  ) => Promise<ProgramFormState>;
  library: LibraryItem[];
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-dark"
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
        New program
      </button>

      <Modal
        open={open}
        onClose={close}
        size="lg"
        title="New program"
        description="Name it, then build it up from your exercise library."
      >
        <ProgramBuilder
          action={action}
          submitLabel="Create program"
          library={library}
          onCancel={close}
        />
      </Modal>
    </>
  );
}
