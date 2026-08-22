// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StuckPendingNotice } from "../app/components/StuckPendingNotice";

/**
 * Issue #26: a Server Action's redirect occasionally never commits
 * client-side on the production build, even though the server completed the
 * request — `useActionState`'s `pending` then never flips back, leaving the
 * submit button stuck with no error and no way out. `StuckPendingNotice` is
 * the mitigation: past a delay, it offers a hard-reload escape hatch.
 *
 * These tests cover the timing contract only — whether the escape hatch
 * appears at the right moment and disappears when it should not be trusted
 * (see NOT `role="alert"` below). The framework navigation defect itself is
 * out of scope here; it is tracked in #26.
 */

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function mount(props: { pending: boolean; afterMs?: number }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;

  act(() => {
    root = createRoot(container);
    root.render(createElement(StuckPendingNotice, props));
  });

  const rerender = (next: { pending: boolean; afterMs?: number }) =>
    act(() => {
      root.render(createElement(StuckPendingNotice, next));
    });

  return {
    container,
    rerender,
    unmount: () => act(() => root.unmount()),
  };
}

describe("StuckPendingNotice", () => {
  it("renders nothing while pending is false", () => {
    const { container } = mount({ pending: false, afterMs: 1000 });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("renders nothing for the first afterMs of a pending action", () => {
    const { container } = mount({ pending: true, afterMs: 1000 });

    act(() => {
      vi.advanceTimersByTime(999);
    });

    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("shows a reload escape hatch once pending outlasts afterMs", () => {
    const { container } = mount({ pending: true, afterMs: 1000 });

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    const notice = container.querySelector('[role="status"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("reload the page");
    // A hard <a> reload, not a client-routed Link — the one navigation kind
    // every reproduction of #26 shows reliably reaching the destination.
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBeTruthy();
  });

  it("does not fire for an action that resolves before afterMs", () => {
    const { container, rerender } = mount({ pending: true, afterMs: 1000 });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    rerender({ pending: false, afterMs: 1000 });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("clears the notice if pending goes true again after resolving stuck", () => {
    const { container, rerender } = mount({ pending: true, afterMs: 1000 });

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.querySelector('[role="status"]')).not.toBeNull();

    // A fresh submit resets the clock rather than leaving a stale notice up.
    rerender({ pending: false, afterMs: 1000 });
    rerender({ pending: true, afterMs: 1000 });
    expect(container.querySelector('[role="status"]')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
