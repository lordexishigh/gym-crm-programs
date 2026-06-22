// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import axe from "axe-core";

import { ProgramView } from "../app/portal/ProgramView";
import { MemberForm } from "../app/dashboard/members/MemberForm";
import { ProgramBuilder } from "../app/dashboard/programs/ProgramBuilder";

/**
 * Automated accessibility checks (beta-polish-a11y-001).
 *
 * Renders the portal + dashboard's core INTERACTIVE surfaces to static markup,
 * mounts them inside a valid document landmark, and runs axe-core's WCAG 2.1
 * A/AA ruleset. This is the "automated a11y checks pass on core pages"
 * acceptance gate — it catches missing form labels, un-named buttons/links,
 * invalid ARIA, and broken list/landmark semantics on every CI run.
 *
 * Scope note: we test the presentational components (`ProgramView`,
 * `MemberForm`, `ProgramBuilder`) rather than the route `page.tsx` files. The
 * pages are async Server Components that pull a session + database, and the
 * login/accept forms value-import `"use server"` actions that resolve `@/`
 * aliases at module load — neither renders in a plain jsdom test. The forms
 * here exercise the same shared label/input/button patterns every other form
 * (login, invite-accept, exercise-library) is built from, so a pass here
 * reflects the app-wide form conventions.
 *
 * `color-contrast` is reported by axe as "incomplete" (not a violation) under
 * jsdom because Tailwind's stylesheet isn't applied, so contrast is enforced
 * centrally in app/globals.css and verified by manual ratio review, not here.
 */

// Render `next/link` as a plain anchor so the App Router context isn't required
// (and link text still flows through axe's link-name check).
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: Record<string, unknown>) =>
    createElement(
      "a",
      { href: typeof href === "string" ? href : "#", ...rest },
      children as React.ReactNode,
    ),
}));

// axe WCAG 2.1 Level A + AA conformance tags (the "WCAG AA basics" criterion).
const AA_OPTIONS: axe.RunOptions = {
  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
};

const noopAction = async () => ({});

beforeAll(() => {
  // A valid page frame so page-level rules (document-title, html-has-lang,
  // region) evaluate the component inside real landmarks instead of flagging
  // the bare fragment.
  document.documentElement.lang = "en";
  document.title = "Alpha CRM — a11y harness";
});

afterEach(() => {
  document.body.innerHTML = "";
});

/** Mount a component's static markup inside a <main> and return axe violations. */
async function violationsFor(element: React.ReactElement) {
  const main = document.createElement("main");
  main.innerHTML = renderToStaticMarkup(element);
  document.body.appendChild(main);
  const results = await axe.run(document.body, AA_OPTIONS);
  // Surface a readable summary if anything fails.
  return results.violations.map((v) => ({
    id: v.id,
    help: v.help,
    nodes: v.nodes.map((n) => n.html),
  }));
}

describe("automated a11y (WCAG A/AA)", () => {
  it("member portal program view has no violations", async () => {
    const violations = await violationsFor(
      createElement(ProgramView, {
        programs: [
          {
            program: {
              id: "prog-1",
              name: "Starting Strength",
              description: "3x/week full body",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
              assigned_at: "2026-01-02T00:00:00.000Z",
            },
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
        ],
      }),
    );
    expect(violations).toEqual([]);
  });

  it("member create/edit form has no violations", async () => {
    const violations = await violationsFor(
      createElement(MemberForm, {
        action: noopAction,
        submitLabel: "Save member",
        defaults: {
          fullName: "Jane Athlete",
          email: "jane@example.com",
          status: "active" as const,
        },
      }),
    );
    expect(violations).toEqual([]);
  });

  it("program builder has no violations", async () => {
    const violations = await violationsFor(
      createElement(ProgramBuilder, {
        action: noopAction,
        submitLabel: "Save program",
        library: [
          {
            id: "lib-1",
            name: "Bench Press",
            sets: 3,
            reps: "8-12",
            rest: "120s",
            notes: null,
          },
        ],
        defaults: {
          name: "Beginner Strength",
          exercises: [
            {
              name: "Back Squat",
              sets: 5,
              reps: "5",
              rest: "180s",
              notes: null,
            },
          ],
        },
      }),
    );
    expect(violations).toEqual([]);
  });
});
