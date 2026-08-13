"use client";

import { useEffect, useId, useRef } from "react";

/**
 * App-wide modal dialog (feedback-2026-08: "make all the create X pages into a
 * popup, so the user never leaves the main data" + "make the popup scrollable
 * when needed").
 *
 * Built on the NATIVE `<dialog>` element rather than a positioned `<div>`. That
 * is the whole point of the component: `showModal()` gives us focus trapping,
 * Escape-to-close, the top layer (so nothing can z-index over it), and `inert`
 * background content from the platform. Hand-rolling those — a focus trap in
 * particular — is the classic way a "simple" modal ships an accessibility
 * regression, and this app has an axe gate (test/a11y.test.ts) that would have
 * to be taught to ignore it.
 *
 * Controlled, not self-managing: the caller owns `open`. Every consumer here
 * closes in response to a SERVER ACTION succeeding, not to the click that
 * submitted it, so the component cannot own that state without also knowing
 * about form state.
 *
 * Children are always mounted, even while closed (a `<dialog>` without the
 * `open` attribute is `display: none`). This keeps the form in the server-
 * rendered markup — so it is present for the a11y scan and for a user whose JS
 * has not hydrated yet — and it costs nothing, because these are small forms.
 */
type ModalProps = {
  open: boolean;
  /** Called on Escape, backdrop click, or the close button. */
  onClose: () => void;
  /** Accessible name for the dialog; also rendered as its heading. */
  title: string;
  /** Optional supporting line under the title, wired to aria-describedby. */
  description?: string;
  /**
   * Panel width. "md" suits a single-column form; "lg" exists for the program
   * builder, whose exercise rows are a multi-column grid that reflows into
   * unreadable slivers at the narrower measure.
   */
  size?: "md" | "lg";
  children: React.ReactNode;
};

const PANEL_WIDTH: Record<NonNullable<ModalProps["size"]>, string> = {
  md: "sm:max-w-2xl",
  lg: "sm:max-w-4xl",
};

export function Modal({
  open,
  onClose,
  title,
  description,
  size = "md",
  children,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  // Drive the native top-layer state from the `open` prop. Guarded on
  // `el.open` both ways: calling showModal() on an already-open dialog throws
  // an InvalidStateError, and close() on a closed one would fire a spurious
  // `close` event that loops back through onClose.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  // A modal `<dialog>` inerts the background but does NOT stop the page behind
  // it from scrolling, so the body scrollbar is suppressed while open. The
  // previous inline value is restored rather than blanked, so this composes
  // with anything else that manages body overflow.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      // `close` covers every native dismissal path at once — Escape, the form
      // method="dialog" button, and el.close() — so there is no separate
      // keydown handler to keep in sync.
      onClose={onClose}
      // The dialog element IS the backdrop: it fills the viewport and lays the
      // panel out centred, so a click landing on the dialog itself (rather than
      // bubbling up from the panel) is by definition a click outside the panel.
      // `::backdrop` is still styled in globals.css for the dimming, but it
      // cannot receive clicks, which is why this sits here instead.
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      // The scrim is styled in globals.css, not with a `backdrop:` utility: a
      // utility class outranks `dialog::backdrop` on specificity and would pin
      // one fixed dimming colour across both themes.
      className="m-0 max-h-none max-w-none bg-transparent p-0 sm:p-4"
      style={{
        // Tailwind has no utility for the dialog's UA-set inset/size, and the
        // element must fill the viewport for the backdrop-click test above to
        // mean "outside the panel".
        width: "100vw",
        height: "100dvh",
        display: open ? "flex" : "none",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/*
        The panel. `max-h-full` + a scrollable body is the "make the popup
        scrollable when needed" requirement: the header and footer stay put
        while only the content scrolls, so the close button is always reachable
        on a phone — which is where the long forms (member, program) actually
        overflow.
      */}
      <div
        className={`flex max-h-full w-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white text-left shadow-xl ${PANEL_WIDTH[size]}`}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id={titleId} className="text-lg font-bold text-slate-900">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="text-sm text-slate-600">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 shrink-0 rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
          >
            <svg
              width={18}
              height={18}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* The only scrolling region. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {children}
        </div>
      </div>
    </dialog>
  );
}
