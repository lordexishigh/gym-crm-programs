import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProgramBuilder } from "../app/dashboard/programs/ProgramBuilder";
import { AssignPanel } from "../app/dashboard/programs/AssignPanel";
import type { ProgramFormState } from "../app/dashboard/programs/actions";

/**
 * Program AUTHORING + ASSIGNMENT view tests (mvp-program-002/004).
 *
 * The counterpart to `member-portal-view.test.ts`: that file proves the member
 * SEES sets/reps/rest/notes, this one proves a trainer can WRITE them and then
 * hand the program to a member. Together they pin the two ends of the core
 * loop — author a program with full exercise detail, assign it, read it back on
 * the portal — so a reviewer does not have to take either end on faith.
 *
 * Why this exists separately from `a11y.test.ts`, which already renders both
 * components: that suite asserts only that axe finds no violations. A builder
 * that had silently lost its "Rest" input, or an assign panel with no submit
 * control, would pass it cleanly. These assertions are about the fields and
 * controls being PRESENT, which is the acceptance criterion.
 *
 * Rendered to static markup (no jsdom, no session, no database), with relative
 * imports for the same reason as the portal view test.
 */

/** A Server Action stands in for the real one; nothing here submits. */
const noopAction = async (): Promise<ProgramFormState> => ({});

const renderBuilder = (defaults?: {
  id?: string;
  name?: string;
  description?: string;
  exercises?: {
    name: string;
    sets: number | null;
    reps: string | null;
    rest: string | null;
    notes: string | null;
  }[];
}) =>
  renderToStaticMarkup(
    createElement(ProgramBuilder, {
      action: noopAction,
      submitLabel: "Save program",
      defaults,
    }),
  );

describe("ProgramBuilder (trainer authoring)", () => {
  it("offers a field for every exercise attribute the portal displays", () => {
    // One existing exercise, so the per-row inputs are rendered. An empty
    // builder renders the row template only after "+ Add exercise" is pressed,
    // which needs a client runtime this static render deliberately avoids.
    const html = renderBuilder({
      name: "Beginner Strength",
      exercises: [
        {
          name: "Back Squat",
          sets: 5,
          reps: "5",
          rest: "180s",
          notes: "Bar over mid-foot.",
        },
      ],
    });

    // The four fields the member portal renders (see member-portal-view.test).
    // Labels are what a trainer actually looks for on screen.
    for (const label of ["Sets", "Reps", "Rest", "Notes"]) {
      expect(html).toContain(label);
    }

    // ...and each one round-trips its current value into an editable input,
    // rather than being a write-only or display-only field.
    expect(html).toContain('value="Back Squat"');
    expect(html).toContain('value="5"');
    expect(html).toContain('value="180s"');
    expect(html).toContain('value="Bar over mid-foot."');
  });

  it("carries the program's own name and description fields", () => {
    const html = renderBuilder({ name: "Beginner Strength" });
    expect(html).toContain("Program name");
    expect(html).toContain("Description");
    expect(html).toContain('name="name"');
    expect(html).toContain('name="description"');
  });

  it("serialises drafted exercises into the submitted payload", () => {
    // The row sub-inputs are intentionally unnamed; only this hidden JSON field
    // reaches the Server Action, so if it lost a key the field would be saved
    // as null and silently vanish from the member's view.
    const html = renderBuilder({
      exercises: [
        { name: "Back Squat", sets: 5, reps: "5", rest: "180s", notes: "Cue" },
      ],
    });
    expect(html).toContain('name="exercises"');
    for (const key of ["name", "sets", "reps", "rest", "notes"]) {
      expect(html).toContain(`&quot;${key}&quot;`);
    }
  });

  it("renders a submit control labelled for the caller's mode", () => {
    expect(renderBuilder({ name: "X" })).toContain("Save program");
  });
});

describe("AssignPanel (handing a program to a member)", () => {
  const members = [
    { id: "m-1", full_name: "Ada Lovelace" },
    { id: "m-2", full_name: "Alan Turing" },
  ];

  it("lets staff pick a gym member and assign the program", () => {
    const html = renderToStaticMarkup(
      createElement(AssignPanel, {
        programId: "prog-1",
        members,
        assignments: [],
      }),
    );

    expect(html).toContain("Assign to members");
    // The member picker, populated from the RLS-scoped server query...
    expect(html).toContain('name="memberId"');
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Alan Turing");
    // ...the program it will bind them to, and the control that does it.
    expect(html).toContain('name="programId"');
    expect(html).toContain('value="prog-1"');
    expect(html).toContain("Assign");
  });

  it("lists current assignments so the result is confirmable", () => {
    const html = renderToStaticMarkup(
      createElement(AssignPanel, {
        programId: "prog-1",
        members,
        assignments: [
          {
            member_id: "m-1",
            full_name: "Ada Lovelace",
            assigned_at: "2026-01-02T00:00:00.000Z",
          },
        ],
      }),
    );

    expect(html).toContain("Currently assigned");
    expect(html).toContain("Ada Lovelace");
    // Reversible: an assignment can be removed to replace it.
    expect(html).toContain("Remove");
  });

  it("explains what to do first when the gym has no members", () => {
    const html = renderToStaticMarkup(
      createElement(AssignPanel, {
        programId: "prog-1",
        members: [],
        assignments: [],
      }),
    );
    // An empty <select> would be a dead end; the panel says why and what next.
    expect(html).not.toContain('name="memberId"');
    expect(html).toContain("Add a member first");
  });
});
