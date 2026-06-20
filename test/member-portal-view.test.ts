import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProgramView } from "../app/portal/ProgramView";
import type { PortalProgram } from "../lib/portal";

/**
 * Member portal VIEW tests (mvp-member-portal-002).
 *
 * Complements the RLS read-path test (which proves isolation at the DB level)
 * by proving the rendered, read-only view meets its acceptance criteria without
 * a session or database. We render `ProgramView` to static markup (no DOM/jsdom
 * required) and assert on the HTML:
 *   - every exercise field (name, sets, reps, rest, notes) is surfaced;
 *   - null fields are omitted rather than breaking layout;
 *   - the empty state shows an appropriate message;
 *   - NO editing affordances exist (no form/input/button/edit-delete/authoring
 *     links) — the member view is strictly read-only.
 */

const program = (overrides: Partial<PortalProgram["program"]> = {}) => ({
  id: "prog-1",
  name: "Starting Strength",
  description: "3x/week full body",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  assigned_at: "2026-01-02T00:00:00.000Z",
  ...overrides,
});

const render = (programs: PortalProgram[]) =>
  renderToStaticMarkup(createElement(ProgramView, { programs }));

describe("ProgramView", () => {
  it("renders every exercise field (name, sets, reps, rest, notes)", () => {
    const html = render([
      {
        program: program(),
        exercises: [
          {
            id: "ex-1",
            program_id: "prog-1",
            position: 0,
            name: "Back Squat",
            sets: 5,
            reps: "5",
            rest: "180s",
            notes: "Keep the bar over mid-foot.",
          },
        ],
      },
    ]);

    expect(html).toContain("Starting Strength");
    expect(html).toContain("Back Squat");
    expect(html).toContain("Sets");
    expect(html).toContain("5"); // sets value
    expect(html).toContain("Reps");
    expect(html).toContain("Rest");
    expect(html).toContain("180s");
    expect(html).toContain("Keep the bar over mid-foot.");
  });

  it("omits null fields without breaking the layout", () => {
    const html = render([
      {
        program: program({ description: null }),
        exercises: [
          {
            id: "ex-2",
            program_id: "prog-1",
            position: 0,
            name: "Plank",
            sets: null,
            reps: null,
            rest: null,
            notes: null,
          },
        ],
      },
    ]);

    // The exercise still renders by name...
    expect(html).toContain("Plank");
    // ...but with no stat labels or notes block for the blank fields.
    expect(html).not.toContain("Sets");
    expect(html).not.toContain("Reps");
    expect(html).not.toContain("Rest");
  });

  it("shows an appropriate empty state when nothing is assigned", () => {
    const html = render([]);
    expect(html).toContain("No program has been assigned to you yet");
  });

  it("exposes NO editing affordances (strictly read-only)", () => {
    const html = render([
      {
        program: program(),
        exercises: [
          {
            id: "ex-1",
            program_id: "prog-1",
            position: 0,
            name: "Back Squat",
            sets: 5,
            reps: "5",
            rest: "180s",
            notes: "n/a",
          },
        ],
      },
    ]);

    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<a "); // no links (e.g. to authoring routes)
    expect(html.toLowerCase()).not.toContain("edit");
    expect(html.toLowerCase()).not.toContain("delete");
  });
});
