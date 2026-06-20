"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/observability/report-client";

/**
 * Staff dashboard error boundary (beta-hardening-001).
 *
 * Catches errors thrown while rendering any `/dashboard/*` route and shows a
 * friendly, recoverable message instead of a stack trace. The error is reported
 * for monitoring; the correlation id (Next.js `digest`) is shown so a staff
 * member can quote it to support.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError(error, "dashboard");
  }, [error]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      <h1 className="text-xl font-bold text-slate-900">Something went wrong</h1>
      <p className="text-sm text-slate-600">
        We couldn&apos;t load this page. The error has been logged and our team
        notified. You can retry, or head back to your dashboard.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
        >
          Try again
        </button>
        <a
          href="/dashboard"
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
        >
          Back to dashboard
        </a>
      </div>
      {error.digest ? (
        <p className="text-xs text-slate-400">Reference: {error.digest}</p>
      ) : null}
    </div>
  );
}
