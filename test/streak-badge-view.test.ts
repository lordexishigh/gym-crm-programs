import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StreakBadge } from "../app/portal/StreakBadge";

/**
 * Member portal streak-badge VIEW tests (CRM-IDEAS "Next" #7). Pure
 * presentation — no session or database — mirroring `workout-history-view`.
 */
describe("StreakBadge", () => {
  it("renders nothing at a 0-day streak", () => {
    const html = renderToStaticMarkup(createElement(StreakBadge, { days: 0 }));
    expect(html).toBe("");
  });

  it("uses singular phrasing for a 1-day streak", () => {
    const html = renderToStaticMarkup(createElement(StreakBadge, { days: 1 }));
    expect(html).toContain("1 day streak");
    expect(html).not.toContain("1 days streak");
  });

  it("uses plural phrasing for a multi-day streak", () => {
    const html = renderToStaticMarkup(createElement(StreakBadge, { days: 5 }));
    expect(html).toContain("5 day streak");
  });

  it("exposes no editing affordances (read-only)", () => {
    const html = renderToStaticMarkup(createElement(StreakBadge, { days: 3 }));
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });
});
