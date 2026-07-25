"use client";

import { useActionState, useEffect, useRef } from "react";
import { kioskCheckInAction, type CheckInState } from "./actions";

const initialState: CheckInState = {};

/**
 * Kiosk check-in form. The input auto-refocuses and clears after every
 * submission (success or error) so a queue of members can check in back to
 * back without touching the mouse — the front-desk speed the market gap
 * calls for.
 */
export function CheckinForm() {
  const [state, formAction, pending] = useActionState(kioskCheckInAction, initialState);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!pending && inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.focus();
    }
  }, [pending, state]);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Scan QR or type PIN
        <input
          ref={inputRef}
          type="text"
          name="code"
          autoFocus
          autoComplete="off"
          className="rounded-lg border border-slate-300 px-4 py-3 text-2xl tracking-widest outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          placeholder="000000"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-dark disabled:opacity-60"
      >
        {pending ? "Checking in…" : "Check in"}
      </button>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p role="status" className="text-sm font-medium text-emerald-700">
          {state.success}
        </p>
      ) : null}
    </form>
  );
}
