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
