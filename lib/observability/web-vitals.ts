/**
 * Mobile performance budget (beta-polish-a11y-002).
 *
 * The member portal is opened on phones over mobile data, so we hold it to an
 * explicit Core Web Vitals budget rather than an informal "feels fast". These
 * thresholds are the Google "good" boundaries — a metric at or below its budget
 * is within target; anything worse is a regression worth seeing.
 *
 * This module is pure (no DOM, no fetch) so the budget logic is unit-tested in
 * isolation and shared by the client reporter (`reportWebVital`) and the docs.
 * The budget itself is documented in docs/ARCHITECTURE.md → "Performance".
 */

/** The Core Web Vitals + load metrics we hold to a budget. */
export type WebVitalName = "LCP" | "INP" | "CLS" | "FCP" | "TTFB";

/**
 * Budget per metric. Times are in milliseconds; CLS is a unitless layout-shift
 * score. A measured value <= its budget is "within budget".
 */
export const MOBILE_PERFORMANCE_BUDGET: Record<WebVitalName, number> = {
  LCP: 2500, // Largest Contentful Paint — main content visible (ms).
  INP: 200, // Interaction to Next Paint — tap responsiveness (ms).
  CLS: 0.1, // Cumulative Layout Shift — visual stability (no major jank).
  FCP: 1800, // First Contentful Paint — first pixels (ms).
  TTFB: 800, // Time to First Byte — server response (ms).
};

/** True when `name` is a metric we hold to a budget. */
export function isBudgetedMetric(name: string): name is WebVitalName {
  return name in MOBILE_PERFORMANCE_BUDGET;
}

/**
 * Whether a measured metric exceeds (is worse than) its budget. Unbudgeted
 * metric names are never over budget. For every metric we track, lower is
 * better, so "over budget" is strictly `value > budget`.
 */
export function exceedsBudget(name: string, value: number): boolean {
  if (!isBudgetedMetric(name)) return false;
  if (!Number.isFinite(value)) return false;
  return value > MOBILE_PERFORMANCE_BUDGET[name];
}
