"use client";

import { useActionState } from "react";
import { acceptInviteAction, type AcceptState } from "./actions";

/**
 * Password-setup form for invite acceptance (mvp-member-management-004).
 * Mobile-first (members open the link on a phone). The raw token rides along as
 * a hidden field; the action re-validates it server-side.
 */
export function AcceptForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<AcceptState, FormData>(
    acceptInviteAction,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />

      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Choose a password
        <input
          type="password"
          name="password"
          autoComplete="new-password"
          required
          minLength={8}
          className="rounded-lg border border-slate-300 px-3 py-3 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          placeholder="At least 8 characters"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Confirm password
        <input
          type="password"
          name="confirm"
          autoComplete="new-password"
          required
          minLength={8}
          className="rounded-lg border border-slate-300 px-3 py-3 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          placeholder="Re-enter your password"
        />
      </label>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-3 text-base font-medium text-white transition hover:bg-brand-dark disabled:opacity-60"
      >
        {pending ? "Setting up…" : "Set up my account"}
      </button>
    </form>
  );
}
