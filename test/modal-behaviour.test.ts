// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Modal } from "../app/components/Modal";

/**
 * Behavioural tests for the create-flow dialog (feedback-2026-08).
 *
 * test/a11y.test.ts renders this component to static markup and scans it; that
 * covers its SEMANTICS but not a single line of its logic, because none of the
 * effects run there. This covers the logic.
 *
 * jsdom 29 does not implement `<dialog>` at all — `showModal`/`close` are simply
 * absent (verified: `typeof dlg.showModal === "undefined"`). So the element API
 * is shimmed below. That is the correct scope rather than a shortcut: the focus
 * trap, the top layer and Escape handling are the PLATFORM's job and are not
 * ours to re-test. What is ours, and what breaks silently if wrong, is the
 * contract with that API:
 *
 *   - `showModal()` (not the `open` attribute) is what opens it, or the dialog
 *     is non-modal and loses the focus trap that motivated using <dialog>,
 *   - it is never called twice (that throws InvalidStateError and would blank
 *     the page with an unhandled error),
 *   - dismissal is wired to every path a user can actually take, and
 *   - the body scroll lock is released again, or the app is left unscrollable.
 */

type ShimmedDialog = HTMLElement & {
  open: boolean;
  showModal: () => void;
  close: () => void;
};

let showModalCalls = 0;
let closeCalls = 0;

beforeEach(() => {
  showModalCalls = 0;
  closeCalls = 0;

  // Minimal, faithful stand-in for the parts of HTMLDialogElement we rely on:
  // showModal/close flip `open`, and close() fires the `close` event that the
  // component listens to for Escape and programmatic dismissal alike.
  Object.defineProperty(HTMLElement.prototype, "open", {
    configurable: true,
    writable: true,
    value: false,
  });
  (HTMLElement.prototype as unknown as ShimmedDialog).showModal = function () {
    showModalCalls++;
    (this as unknown as ShimmedDialog).open = true;
  };
  (HTMLElement.prototype as unknown as ShimmedDialog).close = function () {
    closeCalls++;
    (this as unknown as ShimmedDialog).open = false;
    this.dispatchEvent(new Event("close"));
  };

  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.innerHTML = "";
  document.body.style.overflow = "";
});

/** Mount the Modal and return handles for driving it. */
function mount(props: { open: boolean; onClose: () => void }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;

  act(() => {
    root = createRoot(container);
    root.render(
      createElement(Modal, {
        ...props,
        title: "Add an exercise",
        children: createElement("input", { name: "name" }),
      }),
    );
  });

  const rerender = (next: { open: boolean; onClose: () => void }) =>
    act(() => {
      root.render(
        createElement(Modal, {
          ...next,
          title: "Add an exercise",
          children: createElement("input", { name: "name" }),
        }),
      );
    });

  return {
    dialog: container.querySelector("dialog") as unknown as ShimmedDialog,
    rerender,
    unmount: () => act(() => root.unmount()),
  };
}

describe("Modal", () => {
  it("stays closed, and does not call showModal, while open=false", () => {
    const onClose = vi.fn();
    const { dialog } = mount({ open: false, onClose });

    expect(dialog).toBeTruthy();
    expect(showModalCalls).toBe(0);
    expect(dialog.open).toBe(false);
    // The component must never RENDER the `open` attribute itself. If it did,
    // the dialog would already be open by the time the effect ran, the
    // `!el.open` guard would skip showModal(), and it would display as a
    // non-modal dialog — no top layer, no focus trap. This is the assertion
    // that protects the reason for using <dialog> in the first place.
    expect(dialog.hasAttribute("open")).toBe(false);
    // The children must still be in the markup while closed — that is what puts
    // the form in the server-rendered HTML and under the axe scan.
    expect(dialog.querySelector("input[name='name']")).not.toBeNull();
  });

  it("opens by calling showModal()", () => {
    const onClose = vi.fn();
    const { dialog, rerender } = mount({ open: false, onClose });

    rerender({ open: true, onClose });

    expect(showModalCalls).toBe(1);
    expect(dialog.open).toBe(true);
    // NB: no assertion that the `open` attribute is absent here — a real
    // showModal() sets it (and jsdom's reflecting `open` property does the same
    // through the shim). Its absence only means something before opening.
  });

  it("does not call showModal twice when re-rendered while already open", () => {
    const onClose = vi.fn();
    const { rerender } = mount({ open: false, onClose });

    rerender({ open: true, onClose });
    rerender({ open: true, onClose });

    // A second showModal() on an open dialog throws InvalidStateError.
    expect(showModalCalls).toBe(1);
  });

  it("closes the native dialog when open goes back to false", () => {
    const onClose = vi.fn();
    const { dialog, rerender } = mount({ open: false, onClose });

    rerender({ open: true, onClose });
    rerender({ open: false, onClose });

    expect(closeCalls).toBe(1);
    expect(dialog.open).toBe(false);
  });

  it("reports dismissal when the dialog fires `close` (the Escape path)", () => {
    const onClose = vi.fn();
    const { dialog, rerender } = mount({ open: false, onClose });
    rerender({ open: true, onClose });

    act(() => {
      dialog.dispatchEvent(new Event("close"));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses on a backdrop click but not on a click inside the panel", () => {
    const onClose = vi.fn();
    const { dialog, rerender } = mount({ open: false, onClose });
    rerender({ open: true, onClose });

    // A click on the dialog element itself is, by construction, outside the
    // panel — the panel is a child that fills the centre.
    act(() => {
      dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // A click on content inside the panel bubbles to the dialog too, so the
    // handler MUST discriminate on target or the form would close on every click.
    const input = dialog.querySelector("input[name='name']")!;
    act(() => {
      input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("exposes an accessible name via aria-labelledby", () => {
    const onClose = vi.fn();
    const { dialog } = mount({ open: false, onClose });

    // The staff-journey e2e selects this dialog with
    // `getByRole("dialog", { name: "New program" })`, and screen readers
    // announce the same string. Both resolve the accessible name through
    // aria-labelledby, so a broken/duplicated id here silently turns the dialog
    // into an unnamed one and breaks the selector.
    const id = dialog.getAttribute("aria-labelledby");
    expect(id).toBeTruthy();
    // getElementById rather than a `#id` selector: React's useId emits ids
    // containing characters that are invalid in a CSS selector unescaped, and
    // `CSS.escape` is not available in this jsdom environment.
    const label = document.getElementById(id!);
    expect(label?.textContent).toBe("Add an exercise");
  });

  it("widens the panel for size=lg (the program builder)", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      createRoot(container).render(
        createElement(Modal, {
          open: true,
          onClose: () => {},
          title: "New program",
          size: "lg",
          children: createElement("input", { name: "name" }),
        }),
      );
    });

    // The builder's exercise rows are a multi-column grid; at the default width
    // they reflow into unreadable slivers.
    const panel = container.querySelector("dialog > div")!;
    expect(panel.className).toContain("sm:max-w-4xl");
    expect(panel.className).not.toContain("sm:max-w-2xl");
  });

  it("locks body scroll while open and restores it after", () => {
    const onClose = vi.fn();
    document.body.style.overflow = "auto"; // a pre-existing value to preserve
    const { rerender } = mount({ open: false, onClose });

    rerender({ open: true, onClose });
    expect(document.body.style.overflow).toBe("hidden");

    rerender({ open: false, onClose });
    expect(document.body.style.overflow).toBe("auto");
  });

  it("restores body scroll if it unmounts while still open", () => {
    const onClose = vi.fn();
    document.body.style.overflow = "auto";
    const { rerender, unmount } = mount({ open: false, onClose });

    rerender({ open: true, onClose });
    // The member dialog really does unmount mid-open: createMemberAction
    // redirects on success. Leaking `overflow: hidden` there would leave the
    // destination page unscrollable.
    unmount();

    expect(document.body.style.overflow).toBe("auto");
  });
});
