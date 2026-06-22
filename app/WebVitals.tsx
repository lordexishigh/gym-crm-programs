"use client";

import { useReportWebVitals } from "next/web-vitals";
import { reportWebVital } from "@/lib/observability/report-client";

/**
 * Web Vitals reporter (beta-polish-a11y-002).
 *
 * Mounted once in the root layout. `useReportWebVitals` (built into Next.js — no
 * extra dependency) measures the real Core Web Vitals for every page load and
 * hands each metric to `reportWebVital`, which forwards ONLY budget breaches
 * through the existing `/api/observability/report` pipeline. Renders nothing.
 */
export function WebVitals() {
  useReportWebVitals(reportWebVital);
  return null;
}
