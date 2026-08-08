import Link from "next/link";

/**
 * Branded 404.
 *
 * Next.js ships a bare black-on-white "404 | This page could not be found" when
 * an app has no `not-found.tsx`. That page has no styling, no header and — the
 * part that matters — NO WAY OUT: a visitor who follows a dead link is left with
 * a browser back button as their only option.
 *
 * Dead links are not an edge case here. This product is reached through emailed
 * invite links (`/invite/accept?token=…`) that may be old, forwarded or
 * truncated by a mail client, and through two separate sign-in pages people
 * routinely guess at (`/signin`, `/portal/signin`, `/admin`). Every one of those
 * misses lands here, so this page names both real entry points rather than
 * assuming the visitor knows which surface they belong to.
 *
 * A Server Component: nothing here reads state, and it must render without a
 * database or auth service — a 404 that depends on the things that break is a
 * 500 waiting to happen.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-6 px-5 py-12 text-center">
      <div className="flex flex-col items-center gap-3">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
        >
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
        <p className="text-sm font-semibold uppercase tracking-widest text-slate-500">
          404
        </p>
        <h1 className="text-2xl font-bold">This page doesn&apos;t exist</h1>
        <p className="text-sm text-slate-400">
          The link may be out of date, incomplete, or mistyped. If you followed an
          invite from your gym, the link includes a token that some email apps
          cut short — open it again from the original message, or sign in below.
        </p>
      </div>

      <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
        <Link
          href="/login"
          className="inline-flex items-center justify-center rounded-lg bg-brand px-6 py-3 text-base font-medium text-white shadow-sm transition hover:bg-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
        >
          Staff sign in
        </Link>
        <Link
          href="/portal/login"
          className="inline-flex items-center justify-center rounded-lg border border-hairline-strong px-6 py-3 text-base font-medium text-slate-300 transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
        >
          Member portal
        </Link>
      </div>

      <Link
        href="/"
        className="rounded text-sm font-medium text-brand underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
      >
        Back to start
      </Link>
    </main>
  );
}
