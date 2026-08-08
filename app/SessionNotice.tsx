"use client";

import { useSearchParams } from "next/navigation";

import {
  SIGN_IN_REASON_PARAM,
  signInReasonMessage,
} from "@/lib/auth/sign-in-reason";

/**
 * The "here's why you're back on this form" banner.
 *
 * A guard (or middleware) that redirects to a sign-in page appends a `reason`
 * code; this renders the matching sentence above the form. Without it, a session
 * that expires mid-visit — or any guard that declines a session — drops the user
 * onto a blank login screen that looks identical to a login which silently did
 * nothing. Combined with `DemoSignInHint` directly below the form, someone who
 * arrives here always has both an explanation and the credentials to act on it.
 *
 * A CLIENT component reading `useSearchParams`, deliberately: it keeps `/login`
 * and `/portal/login` STATICALLY PRERENDERED. Reading `searchParams` in the page
 * (a Server Component) would opt both routes into dynamic rendering, and these
 * two routes being static — no database, no auth service, nothing to time out —
 * is what makes them reachable when everything behind them is down. Callers must
 * wrap this in `<Suspense>`; that is what lets the surrounding page prerender
 * while the reason is filled in on the client.
 *
 * Renders nothing for an absent or unrecognised code, so a bare `/login` visit
 * and a crafted `?reason=` value both look like a normal sign-in screen.
 */
export function SessionNotice() {
  const message = signInReasonMessage(
    useSearchParams().get(SIGN_IN_REASON_PARAM),
  );
  if (!message) return null;

  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-left"
    >
      <span
        aria-hidden
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-[13px] font-bold text-amber-700"
      >
        !
      </span>
      <p className="text-sm text-amber-700">{message}</p>
    </div>
  );
}
