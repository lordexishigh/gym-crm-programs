"use client";

import { useActionState } from "react";

import { demoSignInAction } from "./demo-sign-in";

/**
 * The button that actually signs a visitor in as a demo account.
 *
 * Rendered next to the credentials wherever they appear — the landing page and
 * both sign-in forms — so "Sign in with a demo account" is a thing you can DO
 * rather than an instruction to copy two strings into a form. See
 * `app/demo-sign-in.ts` for why this is safe and why it delegates to the real
 * sign-in action instead of reimplementing one.
 *
 * Each button owns its own `useActionState`, so a failure reports against the
 * account that was clicked rather than against the page. That also keeps this
 * usable from `app/page.tsx`, which is a Server Component with no form state of
 * its own.
 *
 * A plain `<form>` posting to a Server Action, deliberately: it needs no
 * client-side fetch of its own, and it does NOT opt the sign-in routes out of
 * static prerendering — which app/SessionNotice.tsx explains is load-bearing,
 * since `/login` and `/portal/login` staying static is what keeps them
 * reachable when the database and auth service are down.
 */
export function DemoSignInButton({
  email,
  label,
}: {
  /** Which demo account to sign in as; validated server-side against the list. */
  email: string;
  /** The button's visible text, e.g. "Sign in as Owner". */
  label: string;
}) {
  const [state, formAction, pending] = useActionState(demoSignInAction, {});

  return (
    <form action={formAction} className="flex flex-col gap-1.5">
      <input type="hidden" name="account" value={email} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex w-full items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
      >
        {pending ? "Signing in…" : label}
      </button>

      {state.error ? (
        <p role="alert" className="text-xs text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
