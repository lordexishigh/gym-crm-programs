"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/observability/report-client";

/**
 * Root route error boundary.
 *
 * The per-surface boundaries (`login/`, `portal/`, `dashboard/`, `invite/`)
 * cover their own segments, and `global-error.tsx` is the last resort for a
 * failure in the root layout itself. This one fills the gap between them: any
 * route WITHOUT its own boundary — the landing page, `/api` render errors
 * surfacing into a page, and any segment added later — previously fell straight
 * through to `global-error.tsx`, which throws away the root layout (and so the
 * app's styling) to render bare inline-styled HTML.
 *
 * That gap is what "no fallback state when auth routes fail" looks like in
 * practice: a dependency is unreachable, nothing renders a message, and the user
 * is left staring at an empty tab with no way forward. A visitor here gets a
 * readable explanation, a retry that re-runs the failed render, and a link back
 * to a page that does not depend on the database.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError(error, "root");
  }, [error]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-4 px-5 py-12 text-center">
      <span
        aria-hidden
        className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10 text-2xl text-amber-400"
      >
        !
      </span>
      <h1 className="text-xl font-bold">Alpha CRM is temporarily unavailable</h1>
      <p className="text-sm text-slate-400">
        We couldn&apos;t finish loading this page. This is usually a short-lived
        problem reaching one of our services — it has been logged and the team
        notified. Please try again in a moment.
      </p>
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
        >
          Try again
        </button>
        <a
          href="/"
          className="rounded-lg border border-hairline-strong px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
        >
          Back to start
        </a>
      </div>
      {error.digest ? (
        <p className="text-xs text-slate-500">Reference: {error.digest}</p>
      ) : null}
    </main>
  );
}
