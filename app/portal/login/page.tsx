"use client";

import { Suspense, useActionState } from "react";
import Link from "next/link";
import { memberLoginAction, type LoginState } from "./actions";
import { DemoSignInHint } from "../../DemoSignInHint";
import { ReadinessNotice } from "../../ReadinessNotice";
import { SessionNotice } from "../../SessionNotice";
import { StuckPendingNotice } from "../../components/StuckPendingNotice";

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
      <div className="flex flex-col items-center gap-4 text-center">
        <Link href="/" className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-base font-bold text-white shadow-sm"
          >
            A
          </span>
          <span className="text-lg font-bold tracking-tight text-brand">
            Alpha CRM
          </span>
        </Link>
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold">Member sign in</h1>
          <p className="text-sm text-slate-600">
            Sign in to view the training programs your gym assigned to you.
          </p>
        </div>
      </div>

      {/* Why the member is on this form — an expired session, or an invite they
          never finished. Inside Suspense so the page still prerenders
          statically (see SessionNotice). */}
      <Suspense fallback={null}>
        <SessionNotice />
      </Suspense>

      {/* A member arrives here from an invite email rather than the landing
          page, so this surface needs the readiness answer of its own. */}
      <ReadinessNotice />

      <form
        action={formAction}
        className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6"
      >
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

        <StuckPendingNotice pending={pending} message="Still signing in?" />
      </form>

      {/* A member usually arrives here from a link in an invite email rather
          than from the landing page, so the demo credentials have to be on this
          screen too — not one screen behind it. */}
      <DemoSignInHint href="/portal/login" />

      <p className="text-center text-sm text-slate-500">
        Gym staff?{" "}
        <Link href="/login" className="font-medium text-brand underline">
          Staff sign in
        </Link>
      </p>
    </main>
  );
}
