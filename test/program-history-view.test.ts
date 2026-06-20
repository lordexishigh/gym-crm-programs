import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProgramHistory } from "../app/portal/ProgramHistory";
import type { AssignedProgram } from "../lib/portal";

/**
 * Member portal history-list VIEW tests (alpha-program-lifecycle-002).
 *
 * Proves the "Past programs" list renders archived programs as read-only links
 * to their detail page, and renders nothing when there is no history — without a
 * session or database (render to static markup, no DOM required).
 */

const archived = (overrides: Partial<AssignedProgram> = {}): AssignedProgram => ({
  id: "prog-1",
  name: "Phase 1",
  description: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  assigned_at: "2026-01-02T00:00:00.000Z",
  ...overrides,
});

const render = (programs: AssignedProgram[]) =>
  renderToStaticMarkup(createElement(ProgramHistory, { programs }));

describe("ProgramHistory", () => {
  it("renders each archived program as a link to its detail page", () => {
    const html = render([
      archived({ id: "p1", name: "Phase 1" }),
      archived({ id: "p2", name: "Phase 2" }),
    ]);

    expect(html).toContain("Past programs");
    expect(html).toContain("Phase 1");
    expect(html).toContain("Phase 2");
    expect(html).toContain('href="/portal/programs/p1"');
    expect(html).toContain('href="/portal/programs/p2"');
  });

  it("renders nothing when there is no history", () => {
    expect(render([])).toBe("");
  });

  it("exposes no editing affordances (links only)", () => {
    const html = render([archived()]);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });
});
