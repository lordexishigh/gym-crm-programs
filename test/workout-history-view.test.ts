import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkoutHistory } from "../app/portal/WorkoutHistory";
import type { WorkoutLogRow } from "../lib/workout-logs";

/**
 * WorkoutHistory VIEW tests (Phase GA — ga-engagement-001).
 *
 * Renders the pure presentation component to static markup (no DOM/db/session)
 * and asserts: each logged session surfaces its program, optional effort, and
 * note; a null effort/note is omitted; and an empty history renders nothing.
 */
const log = (overrides: Partial<WorkoutLogRow> = {}): WorkoutLogRow => ({
  id: "log-1",
  program_id: "prog-1",
  program_name: "Starting Strength",
  completed_at: "2026-02-01T00:00:00.000Z",
  effort: 8,
  note: "Felt strong",
  ...overrides,
});

const render = (logs: WorkoutLogRow[]) =>
  renderToStaticMarkup(createElement(WorkoutHistory, { logs }));

describe("WorkoutHistory", () => {
  it("renders each session's program, effort, and note", () => {
    const html = render([log()]);
    expect(html).toContain("Recent workouts");
    expect(html).toContain("Starting Strength");
    expect(html).toContain("Effort 8/10");
    expect(html).toContain("Felt strong");
  });

  it("omits effort and note when absent", () => {
    const html = render([log({ effort: null, note: null })]);
    expect(html).toContain("Starting Strength");
    expect(html).not.toContain("Effort");
  });

  it("renders nothing when there is no history", () => {
    expect(render([])).toBe("");
  });
});
