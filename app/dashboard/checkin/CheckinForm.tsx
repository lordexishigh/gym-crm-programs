"use client";

import { useActionState, useEffect, useRef } from "react";
import { Avatar } from "@/app/components/Avatar";
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
        {/* One button for both directions — the server decides which, from
            whether the member has an open visit. See lib/checkin.ts. */}
        {pending ? "Recording…" : "Check in / out"}
      </button>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        // The photo is the point of the confirmation: a PIN or scan proves
        // possession of a code, not identity, so the desk sees the face the
        // code belongs to. Falls back to initials for a member with no photo.
        //
        // Arrival and departure must not look the same — the desk is glancing,
        // not reading, so direction carries a colour as well as a word.
        //
        // Tinted with brand/slate tokens rather than the literal `emerald-50` /
        // `emerald-200` pair. `bg-emerald-50` was already remapped for dark
        // (globals.css) so its contrast was fine, but `border-emerald-200` was
        // NOT in that remap and rendered as a pale hairline. Tokens that resolve
        // per theme avoid needing a remap entry at all, which matters now that
        // there are two themes to keep correct.
        <div
          role="status"
          className={
            state.direction === "out"
              ? "flex items-center gap-3 rounded-xl border border-slate-300 bg-slate-100 p-3"
              : "flex items-center gap-3 rounded-xl border border-brand/40 bg-brand/10 p-3"
          }
        >
          <Avatar
            name={state.member?.name ?? ""}
            src={state.member?.avatarSrc ?? null}
            size="md"
          />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-base font-semibold text-slate-900">
              {state.member?.name ?? state.success}
            </span>
            <span className="text-sm font-medium text-slate-600">
              {state.direction === "out" ? "Checked out" : "Checked in"}
            </span>
          </span>
        </div>
      ) : null}
    </form>
  );
}
