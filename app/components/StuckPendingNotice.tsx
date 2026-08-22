"use client";

import { useEffect, useState } from "react";

/**
 * Issue #26: on the production build, a Server Action's redirect occasionally
 * never commits client-side even though the request completed correctly on
 * the server — the write lands, session cookies are set, the response carries
 * a valid `x-action-redirect` — but the client-side transition never fires.
 * `useActionState`'s `pending` then never flips back, so the submit button is
 * stuck on its pending label forever with no error rendered anywhere.
 *
 * This does not fix that navigation defect (still open, tracked in #26). It
 * gives someone stuck on it a way out instead of an indefinite silent
 * spinner: past `afterMs` of continuous pending, offer a hard reload. Every
 * reproduction on record shows a plain GET of the destination renders
 * correctly once the server has actually applied the write, so a real
 * (non-client-routed) navigation reliably recovers.
 */
export function StuckPendingNotice({
  pending,
  message = "This is taking longer than expected.",
  afterMs = 10_000,
}: {
  pending: boolean;
  message?: string;
  afterMs?: number;
}) {
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    if (!pending) {
      setStuck(false);
      return;
    }
    const timer = window.setTimeout(() => setStuck(true), afterMs);
    return () => window.clearTimeout(timer);
  }, [pending, afterMs]);

  if (!stuck) return null;

  return (
    <p
      role="status"
      className="flex flex-col gap-1 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700"
    >
      <span>{message}</span>
      <span>
        Your last action may already have gone through —{" "}
        <a href={window.location.href} className="font-medium underline">
          reload the page
        </a>{" "}
        to check.
      </span>
    </p>
  );
}
