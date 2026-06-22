"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/observability/report-client";

/**
 * Member portal error boundary (beta-hardening-001).
 *
 * Catches errors thrown while rendering any `/portal/*` route and shows a
 * friendly, mobile-first message instead of a stack trace. The error is
 * reported for monitoring; the correlation id (Next.js `digest`) is shown so a
 * member can quote it to their gym.
 */
export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError(error, "portal");
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-sm flex-col items-center justify-center gap-4 px-4 py-12 text-center">
      <h1 className="text-xl font-bold text-slate-900">Something went wrong</h1>
      <p className="text-sm text-slate-600">
        We couldn&apos;t load your training right now. The error has been logged.
        Please try again in a moment.
      </p>
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
        >
          Try again
        </button>
        <a
          href="/portal"
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
        >
          Back to my programs
        </a>
      </div>
      {error.digest ? (
        <p className="text-xs text-slate-400">Reference: {error.digest}</p>
      ) : null}
    </div>
  );
}
