"use client";

import { useActionState } from "react";
import Link from "next/link";
import { memberLoginAction, type LoginState } from "./actions";

const initialState: LoginState = {};

/**
 * Member portal login — mobile-first (the portal is opened on a phone browser).
 * Inputs use base text size to avoid iOS zoom-on-focus and large tap targets.
 */
export default function MemberLoginPage() {
  const [state, formAction, pending] = useActionState(
    memberLoginAction,
    initialState,
  );

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-5 py-12">
      <div className="flex flex-col gap-1 text-center">
        <Link href="/" className="text-sm font-semibold text-brand">
          Alpha CRM
        </Link>
        <h1 className="text-2xl font-bold">Member sign in</h1>
        <p className="text-sm text-slate-600">
          Sign in to view the training programs your gym assigned to you.
        </p>
      </div>

      <form action={formAction} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Email
          <input
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            required
            className="rounded-lg border border-slate-300 px-3 py-3 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            placeholder="you@example.com"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Password
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            className="rounded-lg border border-slate-300 px-3 py-3 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            placeholder="••••••••"
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
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="text-center text-sm text-slate-500">
        Gym staff?{" "}
        <Link href="/login" className="font-medium text-brand underline">
          Staff sign in
        </Link>
      </p>
    </main>
  );
}
