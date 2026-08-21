"use server";

import { DEMO_ACCOUNTS } from "@/lib/demo-accounts";
import { loginAction, type LoginState } from "./login/actions";
import { memberLoginAction } from "./portal/login/actions";

/**
 * One-click sign-in as a seeded demo account.
 *
 * WHY THIS EXISTS
 *
 * The app has no public sign-up, so the demo accounts are the only way anyone
 * can see the product. `lib/demo-accounts.ts` put the credentials on screen,
 * which fixed "a tester cannot find any credentials" — but the panel headed
 * "Sign in with a demo account" then offered nothing but a LINK to an empty
 * form, so acting on it still meant hand-copying an email and a password out of
 * a `<code>` block. A review walking the app reported exactly that: the demo
 * link "goes nowhere usable", and because the demo flow is the only path in,
 * every feature behind the login was left unverifiable.
 *
 * WHY THIS IS NOT AN AUTH BYPASS
 *
 * The action takes an account IDENTIFIER, never a password. The submitted value
 * is looked up in `DEMO_ACCOUNTS` — a fixed, server-side list — and anything not
 * in it is refused, so this cannot be pointed at an arbitrary account. The
 * credentials it then uses are the ones already printed on the page, so it
 * grants nothing a visitor could not get by typing what they can already read.
 *
 * It also does not re-implement sign-in. It delegates to the SAME action the
 * form posts to, which is what keeps the demo path honest: rate limiting, token
 * re-verification, the staff/member audience gate, the destination dry-run that
 * prevents the login→dashboard→login loop, and session establishment all still
 * happen, and any future change to sign-in applies here automatically. A demo
 * that skipped those would be testing a code path no real user takes.
 *
 * Failures surface as `LoginState.error` on the button, so a deployment where
 * the seed has not been run (or where the `SEED_*` defaults were overridden —
 * see `DEMO_ACCOUNTS_CAVEAT`) says so on the screen instead of doing nothing.
 */
export async function demoSignInAction(
  prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const requested = String(formData.get("account") ?? "")
    .trim()
    .toLowerCase();

  const account = DEMO_ACCOUNTS.find(
    (candidate) => candidate.email.toLowerCase() === requested,
  );
  if (!account) {
    return { error: "That demo account isn't available on this deployment." };
  }

  // Hand the real sign-in action the credentials it expects. Built here rather
  // than posted by the browser so the password never travels from the client and
  // cannot be swapped for a guess.
  const credentials = new FormData();
  credentials.set("email", account.email);
  credentials.set("password", account.password);

  // On success both of these `redirect()`, which throws NEXT_REDIRECT and
  // unwinds through here to navigate the browser — so there is no success branch
  // to return.
  return account.href === "/portal/login"
    ? memberLoginAction(prevState, credentials)
    : loginAction(prevState, credentials);
}
