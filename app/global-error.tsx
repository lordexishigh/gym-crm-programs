"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/observability/report-client";

/**
 * Root error boundary (beta-hardening-001).
 *
 * `global-error.tsx` is the last-resort boundary — it catches errors thrown by
 * the root layout itself, so it must render its own <html>/<body>. The
 * per-segment `dashboard/error.tsx` and `portal/error.tsx` handle the common
 * case with surface-appropriate styling; this one is the bare fallback. It
 * shows a friendly message (never a stack trace) plus the correlation id for
 * support, and reports the error for monitoring.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError(error, "global");
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, Segoe UI, Arial, sans-serif", margin: 0 }}>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            color: "#0f172a",
          }}
        >
          <div style={{ maxWidth: 420, textAlign: "center" }}>
            <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
              Something went wrong
            </h1>
            <p style={{ color: "#475569", marginBottom: 20 }}>
              We hit an unexpected error and our team has been notified. Please
              try again in a moment.
            </p>
            <button
              type="button"
              onClick={reset}
              style={{
                background: "#0f766e",
                color: "#fff",
                border: "none",
                padding: "10px 18px",
                borderRadius: 8,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            {error.digest ? (
              <p style={{ color: "#94a3b8", fontSize: 12, marginTop: 16 }}>
                Reference: {error.digest}
              </p>
            ) : null}
          </div>
        </div>
      </body>
    </html>
  );
}
