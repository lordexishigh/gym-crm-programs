"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/observability/report-client";

/**
 * Invite-acceptance error boundary (beta-hardening-001).
 *
 * Catches errors thrown while rendering any `/invite/*` route (the onboarding
 * flow) and shows a friendly message instead of a stack trace. The error is
 * reported for monitoring; the correlation id (Next.js `digest`) is shown so
 * the invitee can quote it to their gym.
 */
export default function InviteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError(error, "invite");
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-sm flex-col items-center justify-center gap-4 px-4 py-12 text-center">
      <h1 className="text-xl font-bold text-slate-900">Something went wrong</h1>
      <p className="text-sm text-slate-600">
        We couldn&apos;t process your invite right now. The error has been
        logged. Please try again, or ask your gym to resend the invite.
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
      >
        Try again
      </button>
      {error.digest ? (
        <p className="text-xs text-slate-400">Reference: {error.digest}</p>
      ) : null}
    </div>
  );
}
