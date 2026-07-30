import Link from "next/link";

import { DEMO_ACCOUNTS, DEMO_ACCOUNTS_CAVEAT } from "@/lib/demo-accounts";

/**
 * Landing page.
 *
 * Carries the DEMO ACCOUNT NOTICE, which is load-bearing rather than
 * decorative: the app has no public sign-up (members are invite-only, staff are
 * seeded), so without credentials on this screen a first-time visitor or QA
 * tester reaches the login form and stops there. The list is static — no DB
 * call, no client JS — so it renders on the prerendered page and is visible even
 * when the database or auth service is unreachable, which is precisely when
 * someone is most likely to be poking at the app. See lib/demo-accounts.ts for
 * why the values live in a shared module and how they are kept in step with
 * `scripts/seed.mjs`.
 */
export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col items-center justify-center gap-8 px-5 py-12 text-center">
      <div className="flex flex-col items-center gap-3">
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-base font-bold text-white shadow-sm"
          >
            A
          </span>
          <span className="text-sm font-semibold uppercase tracking-widest text-brand">
            Alpha CRM
          </span>
        </span>
        <h1 className="text-3xl font-bold leading-tight sm:text-4xl">
          Training programs your members can actually open.
        </h1>
        <p className="mx-auto max-w-xl text-base text-slate-600 sm:text-lg">
          A multi-tenant CRM for Cyprus gyms. Trainers build programs and assign
          them to members, who view them on a mobile-first portal — with every
          gym&apos;s data isolated at the database layer.
        </p>
      </div>

      <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
        <Link
          href="/login"
          className="inline-flex items-center justify-center rounded-lg bg-brand px-6 py-3 text-base font-medium text-white shadow-sm transition hover:bg-brand-dark"
        >
          Staff sign in
        </Link>
        <Link
          href="/portal/login"
          className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-6 py-3 text-base font-medium text-slate-700 transition hover:bg-slate-100"
        >
          Member portal
        </Link>
      </div>

      <DemoAccounts />
    </main>
  );
}

/**
 * The "try it without setting anything up" panel.
 *
 * Credentials are rendered in `<code>` so they can be selected and copied
 * cleanly (no smart quotes, no line-wrap surprises in a password containing
 * `!`), and each row links straight to the sign-in screen that accepts it —
 * a tester should never have to work out which of the two logins a given
 * account belongs to.
 */
function DemoAccounts() {
  return (
    <section
      aria-labelledby="demo-accounts-heading"
      className="w-full rounded-xl border border-slate-200 bg-white p-5 text-left sm:p-6"
    >
      <div className="flex flex-col gap-1 border-b border-slate-200 pb-4">
        <h2
          id="demo-accounts-heading"
          className="flex items-center gap-2 text-sm font-semibold text-slate-900"
        >
          <span
            aria-hidden
            className="inline-flex h-5 items-center rounded-md bg-emerald-50 px-2 text-[11px] font-semibold uppercase tracking-wide text-emerald-700"
          >
            Demo
          </span>
          Sign in with a demo account
        </h2>
        <p className="text-sm text-slate-600">
          This is a demonstration deployment with no public sign-up. Use any
          account below — no setup required.
        </p>
      </div>

      <ul className="flex flex-col divide-y divide-slate-200">
        {DEMO_ACCOUNTS.map((account) => (
          <li
            key={account.email}
            className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
          >
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-sm font-semibold text-slate-900">
                  {account.role}
                </span>
                <span className="text-xs text-slate-500">{account.surface}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[13px] text-slate-700">
                  {account.email}
                </code>
                <span aria-hidden className="text-slate-500">
                  /
                </span>
                <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[13px] text-slate-700">
                  {account.password}
                </code>
              </div>
              <p className="text-xs text-slate-500">{account.blurb}</p>
            </div>

            <Link
              href={account.href}
              className="inline-flex shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Go to {account.surface.toLowerCase()}
            </Link>
          </li>
        ))}
      </ul>

      <p className="border-t border-slate-200 pt-4 text-xs text-slate-500">
        {DEMO_ACCOUNTS_CAVEAT}
      </p>
    </section>
  );
}
