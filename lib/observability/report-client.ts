import { exceedsBudget } from "./web-vitals";

/**
 * Browser-side error reporter (beta-hardening-001).
 *
 * Imported only by the client `error.tsx` boundaries. It POSTs a minimal report
 * to `/api/observability/report`, which performs the actual server-side
 * `captureException` (the boundary itself cannot reach monitoring credentials).
 * Best-effort: a failed report must never throw inside an error boundary.
 */
export function reportClientError(
  error: Error & { digest?: string },
  surface: string,
): void {
  try {
    void fetch("/api/observability/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: error.message,
        digest: error.digest,
        surface,
        path: typeof window !== "undefined" ? window.location.pathname : undefined,
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Swallow — reporting is strictly best-effort.
  }
}

/**
 * Web Vitals budget reporter (beta-polish-a11y-002).
 *
 * Wired from `<WebVitals />` via Next's `useReportWebVitals`. Forwarded through
 * the SAME `/api/observability/report` sink as client errors (no parallel
 * client) — only metrics that BREACH the mobile performance budget are sent, so
 * the sink stays quiet on healthy sessions and a budget regression surfaces as a
 * monitored event. Best-effort: it must never throw in the render path.
 */
export function reportWebVital(metric: {
  name: string;
  value: number;
  id: string;
  rating?: string;
}): void {
  try {
    // Only forward over-budget metrics — within-budget is the expected case and
    // would just be noise (and extra mobile-data requests).
    if (!exceedsBudget(metric.name, metric.value)) return;
    void fetch("/api/observability/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "web-vital",
        name: metric.name,
        value: metric.value,
        rating: metric.rating,
        path:
          typeof window !== "undefined" ? window.location.pathname : undefined,
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Swallow — reporting is strictly best-effort.
  }
}
