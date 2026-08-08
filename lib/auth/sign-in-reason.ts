/**
 * Why a visitor is standing on a sign-in form.
 *
 * Two different failures used to land a user on `/login` or `/portal/login` with
 * an empty form and no explanation:
 *
 *   1. A guard bounced them there (`requireStaff` / `requireMember` in
 *      lib/auth/session.ts, or middleware's no-usable-session path).
 *   2. They had *just* signed in successfully, and the destination guard
 *      rejected the brand-new session — see the `identityFromClaims` note in
 *      app/login/actions.ts.
 *
 * Case 2 is now prevented at its source (the login actions refuse to establish a
 * session that cannot resolve an identity), so anyone arriving with a reason
 * code is in a genuinely recoverable state. But arriving with no message at all
 * is indistinguishable from "sign-in silently did nothing", which is the dead
 * end the review found. So the guards say WHY, and the forms show it.
 *
 * Deliberately dependency-free — no `pg`, no `next/headers`, no `next/server`.
 * This module is imported by EDGE middleware, by server-side guards, and by a
 * CLIENT component (`app/SessionNotice.tsx`), so it must be safe in all three.
 */

/**
 * Where each role lands after a successful sign-in.
 *
 * Kept here rather than inline in the actions for two reasons: a `"use server"`
 * module may only export async functions, and the review's finding was that
 * neither destination had ever been *confirmed* — as named constants they are
 * asserted by test/post-login-redirect.test.ts. Both routes exist and render
 * without depending on the gym having any data (app/dashboard/page.tsx shows
 * zeroed KPIs, app/portal/page.tsx shows "no program assigned yet"), so a
 * freshly seeded demo gym is never a blank screen.
 */
export const STAFF_LANDING = "/dashboard";
export const MEMBER_LANDING = "/portal";

/** Query-string key carrying the reason (`/login?reason=session-expired`). */
export const SIGN_IN_REASON_PARAM = "reason";

/**
 * The recognised reasons. Kept to states a visitor can actually act on — an
 * unrecognised or absent value renders nothing rather than an alarming banner.
 */
export type SignInReason = "session-expired" | "setup-incomplete";

const MESSAGES: Record<SignInReason, string> = {
  "session-expired":
    "Your session has ended, so we brought you back here. Sign in again to pick up where you left off.",
  "setup-incomplete":
    "Your account setup isn't finished, so the portal has nothing to show you yet. Open the link in your invite email to complete it.",
};

/**
 * The message for a raw query-string value, or `null` when there is nothing to
 * say. `Object.hasOwn` rather than `in` so a crafted `?reason=toString` cannot
 * reach a prototype member.
 */
export function signInReasonMessage(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  return Object.hasOwn(MESSAGES, raw) ? MESSAGES[raw as SignInReason] : null;
}

/** Build a sign-in URL that explains itself. */
export function signInPathWithReason(
  path: "/login" | "/portal/login",
  reason: SignInReason,
): string {
  return `${path}?${SIGN_IN_REASON_PARAM}=${reason}`;
}

/**
 * Shown on the sign-in FORM (not as a reason code) when credentials are valid
 * but the resulting token carries no `tenant_id`, so no gym — and therefore no
 * dashboard or portal — can be resolved for it.
 *
 * There is nothing the visitor can do in the app to fix this, and nothing to
 * sign in *to*, so the honest answer is "ask your gym", not "try again".
 */
export const ACCOUNT_NOT_LINKED_TO_GYM =
  "This account isn't linked to a gym yet, so there's nothing to sign in to. Please contact your gym to finish setting it up.";
