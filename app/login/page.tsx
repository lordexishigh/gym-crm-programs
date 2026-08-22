"use client";

import { Suspense, useActionState } from "react";
import Link from "next/link";
import { loginAction, type LoginState } from "./actions";
import { DemoSignInHint } from "../DemoSignInHint";
import { ReadinessNotice } from "../ReadinessNotice";
import { SessionNotice } from "../SessionNotice";
import { StuckPendingNotice } from "../components/StuckPendingNotice";

const initialState: LoginState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(
    loginAction,
    initialState,
  );

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-5 py-12">
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
          <h1 className="text-2xl font-bold">Staff sign in</h1>
          <p className="text-sm text-slate-600">
            For gym staff and trainers. Members sign in at the{" "}
            <Link href="/portal/login" className="font-medium text-brand underline">
              member portal
            </Link>
            .
          </p>
        </div>
      </div>

      {/* Why the visitor is on this form, when a guard sent them here. Inside
          Suspense so the page still prerenders statically (see SessionNotice). */}
      <Suspense fallback={null}>
        <SessionNotice />
      </Suspense>

      {/* A tester usually reaches this form directly (a guard redirect, a deep
          link), so "this deployment cannot sign anyone in" has to be here too —
          on the landing page alone it is one screen behind them. */}
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
            required
            className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
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
            className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
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

      {/* Reached directly (deep link, bookmark, or the redirect a guarded route
          performs without a session), this page is a dead end without
          credentials — the landing page's notice is one screen behind. */}
      <DemoSignInHint href="/login" />
    </main>
  );
}
