/**
 * Root loading state.
 *
 * Server Components that await a slow dependency (a cold database connection on
 * the first request of a deploy, a token refresh) otherwise stream nothing until
 * they resolve, so a slow route is indistinguishable from a broken one — a blank
 * tab either way. This suspense fallback gives the navigation immediate visible
 * feedback, and pairs with the bounded DB waits in `lib/db.ts`: the user sees
 * "loading" for at most that budget, then `error.tsx` explains what failed.
 *
 * Deliberately a Server Component (no "use client") — it ships no JS, and the
 * pulse is pure CSS.
 */
export default function RootLoading() {
  return (
    <main
      className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-4 px-5 py-12 text-center"
      // Announce the wait to assistive tech rather than leaving it silent.
      role="status"
      aria-live="polite"
    >
      <span
        aria-hidden
        className="flex h-9 w-9 animate-pulse items-center justify-center rounded-xl bg-brand text-base font-bold text-white shadow-sm"
      >
        A
      </span>
      <p className="text-sm text-slate-400">Loading Alpha CRM…</p>
    </main>
  );
}
