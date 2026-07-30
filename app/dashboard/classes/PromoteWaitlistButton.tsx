"use client";

import { useActionState } from "react";
import { promoteFromWaitlistAction, type PromoteWaitlistState } from "./actions";

const initialState: PromoteWaitlistState = {};

/**
 * Staff control to fill a class's open spots from its waitlist on demand.
 *
 * Cancellations promote automatically, so this is the manual backstop for
 * vacancies that appeared some other way. It is only rendered when there is
 * both someone waiting and a spot free (see the class detail page), so a
 * disabled-looking dead button never appears.
 */
export function PromoteWaitlistButton({
  classId,
  openSpots,
  waitlistCount,
}: {
  classId: string;
  openSpots: number;
  waitlistCount: number;
}) {
  const [state, formAction, pending] = useActionState(promoteFromWaitlistAction, initialState);

  const fillable = Math.min(openSpots, waitlistCount);

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-amber-900">
          {fillable === 1
            ? "1 open spot can be filled from the waitlist"
            : `${fillable} open spots can be filled from the waitlist`}
        </p>
        <p className="text-xs text-amber-800">
          Cancellations promote automatically. Use this if a spot opened up another
          way — the members promoted are emailed straight away.
        </p>
      </div>

      <form action={formAction}>
        <input type="hidden" name="classId" value={classId} />
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Promoting…" : "Fill from waitlist"}
        </button>
      </form>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p role="status" className="text-sm font-medium text-brand-dark">
          {state.success}
        </p>
      ) : null}
    </div>
  );
}
