import { DEMO_ACCOUNTS, DEMO_ACCOUNTS_CAVEAT } from "@/lib/demo-accounts";

/**
 * The demo credentials for ONE sign-in surface, rendered under its form.
 *
 * The landing page already carries the full notice (see `app/page.tsx`), and
 * that covers a visitor who arrives at `/`. It does not cover the visitor who
 * arrives at a sign-in form directly — a deep link, a bookmark, or the
 * redirect a guarded route performs when the session is missing, which is how
 * a QA harness usually reaches `/login` — because the credentials are then one
 * screen BEHIND them. So the same static list is repeated here, filtered to the
 * accounts this form actually accepts: a tester on `/portal/login` is shown the
 * member account, not the two staff accounts that would fail against it.
 *
 * Presentational and static: no hooks, no `"use client"` of its own, no
 * database or network call. It is imported by client components, so it must
 * stay free of anything server-only — `lib/demo-accounts` is deliberately
 * `lib/db`-free for exactly this reason — and it renders in the server pass of
 * both forms, which means the credentials are on screen even when auth or the
 * database is down. That is precisely when someone is most likely to be looking
 * for them.
 *
 * Both this and the landing page read the one shared list, so
 * `test/demo-accounts.test.ts` (which pins that list to `scripts/seed.mjs`'s
 * defaults) keeps every copy honest at once.
 */
export function DemoSignInHint({ href }: { href: "/login" | "/portal/login" }) {
  const accounts = DEMO_ACCOUNTS.filter((account) => account.href === href);
  if (accounts.length === 0) return null;

  return (
    <section
      aria-labelledby="demo-signin-heading"
      className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 text-left"
    >
      <h2
        id="demo-signin-heading"
        className="flex items-center gap-2 text-sm font-semibold text-slate-900"
      >
        <span
          aria-hidden
          className="inline-flex h-5 items-center rounded-md bg-emerald-50 px-2 text-[11px] font-semibold uppercase tracking-wide text-emerald-700"
        >
          Demo
        </span>
        Try it with a demo account
      </h2>

      <ul className="flex flex-col gap-2">
        {accounts.map((account) => (
          <li key={account.email} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              {/* `<code>` so a password containing `!` can be selected and
                  copied without smart quotes or a mid-token line break. */}
              <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[13px] text-slate-700 ring-1 ring-slate-200">
                {account.email}
              </code>
              <span aria-hidden className="text-slate-500">
                /
              </span>
              <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[13px] text-slate-700 ring-1 ring-slate-200">
                {account.password}
              </code>
            </div>
            <p className="text-xs text-slate-500">
              {account.role} — {account.blurb}
            </p>
          </li>
        ))}
      </ul>

      <p className="text-xs text-slate-500">{DEMO_ACCOUNTS_CAVEAT}</p>
    </section>
  );
}
