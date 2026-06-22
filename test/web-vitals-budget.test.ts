import { describe, expect, it } from "vitest";

import {
  MOBILE_PERFORMANCE_BUDGET,
  exceedsBudget,
  isBudgetedMetric,
} from "../lib/observability/web-vitals";

/**
 * Mobile performance budget logic (beta-polish-a11y-002).
 *
 * The budget decides which Core Web Vitals get forwarded to monitoring, so its
 * boundary behaviour is pinned here: at-budget passes, over-budget fails, and
 * unknown / non-finite metrics are never reported.
 */
describe("mobile performance budget", () => {
  it("recognises exactly the budgeted metric names", () => {
    expect(isBudgetedMetric("LCP")).toBe(true);
    expect(isBudgetedMetric("CLS")).toBe(true);
    expect(isBudgetedMetric("INP")).toBe(true);
    expect(isBudgetedMetric("FID")).toBe(false);
    expect(isBudgetedMetric("")).toBe(false);
  });

  it("treats a value at the budget as within budget (boundary is inclusive)", () => {
    for (const [name, budget] of Object.entries(MOBILE_PERFORMANCE_BUDGET)) {
      expect(exceedsBudget(name, budget)).toBe(false);
    }
  });

  it("flags a value worse than the budget as over budget", () => {
    expect(exceedsBudget("LCP", MOBILE_PERFORMANCE_BUDGET.LCP + 1)).toBe(true);
    expect(exceedsBudget("CLS", MOBILE_PERFORMANCE_BUDGET.CLS + 0.01)).toBe(
      true,
    );
    expect(exceedsBudget("INP", MOBILE_PERFORMANCE_BUDGET.INP + 50)).toBe(true);
  });

  it("never flags a value better than the budget", () => {
    expect(exceedsBudget("LCP", 1000)).toBe(false);
    expect(exceedsBudget("CLS", 0)).toBe(false);
  });

  it("ignores unknown metrics and non-finite values", () => {
    expect(exceedsBudget("UNKNOWN", 999999)).toBe(false);
    expect(exceedsBudget("LCP", Number.NaN)).toBe(false);
    expect(exceedsBudget("LCP", Number.POSITIVE_INFINITY)).toBe(false);
  });
});
