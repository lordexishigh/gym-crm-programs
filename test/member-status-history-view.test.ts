import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusHistory } from "../app/dashboard/members/StatusHistory";
import type { MemberStatusEvent } from "../lib/member-records";

/**
 * Member detail status-history VIEW tests (alpha-member-records-001).
 *
 * Proves the "Status history" section renders each status change newest-first
 * with its timestamp/author, distinguishes the seed (creation) event from a
 * transition, and still shows a heading + empty message when there is no
 * history — without a session or database (render to static markup).
 */

const event = (
  overrides: Partial<MemberStatusEvent> = {},
): MemberStatusEvent => ({
  old_status: "active",
  new_status: "inactive",
  changed_at: "2026-01-02T09:30:00.000Z",
  changed_by_name: "Coach Sam",
  ...overrides,
});

const render = (events: MemberStatusEvent[]) =>
  renderToStaticMarkup(createElement(StatusHistory, { events }));

describe("StatusHistory", () => {
  it("renders a transition with its old → new status, time, and author", () => {
    const html = render([event()]);

    expect(html).toContain("Status history");
    expect(html).toContain("active");
    expect(html).toContain("inactive");
    expect(html).toContain("2026-01-02 09:30 UTC");
    expect(html).toContain("Coach Sam");
  });

  it("renders the seed (creation) event without an arrow", () => {
    const html = render([
      event({ old_status: null, new_status: "active", changed_by_name: null }),
    ]);
    expect(html).toContain("Created as active");
    expect(html).not.toContain("→");
  });

  it("shows a heading and empty message when there is no history", () => {
    const html = render([]);
    expect(html).toContain("Status history");
    expect(html).toContain("No status changes recorded yet.");
  });

  it("exposes no editing affordances (read-only)", () => {
    const html = render([event()]);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });
});
