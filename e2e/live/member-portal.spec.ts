import { expect, test } from "@playwright/test";

import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "../../lib/auth/cookies";
import { MEMBER_LANDING } from "../../lib/auth/sign-in-reason";
import { DEMO_ACCOUNTS } from "../../lib/demo-accounts";

/**
 * Does MEMBER sign-in reach the portal on a deployment that is already running?
 *
 * WHY THIS EXISTS ALONGSIDE ./staff-login.spec.ts
 *
 * That spec closed the same gap for staff, and deliberately stopped there. But
 * the member portal — an invited member opening the program their trainer built
 * — is the product's wedge, and it was the half with no live artifact at all.
 * Two things made that gap actively misleading rather than merely incomplete:
 *
 *   - `/portal` and `/portal/login` are statically prerendered, so `curl` gets
 *     200 from a deployment whose member sign-in is entirely broken. Rendering
 *     is not working, exactly as `scripts/deploy.mjs` says of /login.
 *   - The local suite's equivalent assertion — `toHaveURL(/\/portal$/)` after a
 *     member submits credentials (e2e/invite-flow.spec.ts) — has been failing
 *     in CI deterministically (issue #26). That local run drives a GoTrue
 *     stand-in (e2e/auth-stub.mjs) over http, so it cannot distinguish "the
 *     product's core journey is broken" from "the stub or the http origin is".
 *     Only a real browser against the real deployment can, and until this spec
 *     existed nothing did. Read the two together: if this passes while the
 *     local one fails, the defect is in the harness, not the product.
 *
 * Runs under `playwright.live.config.ts` (which starts no servers) and is
 * excluded from the default ./e2e run, whose stubbed auth has no demo accounts.
 *
 * NO WRONG-PASSWORD CASE, for the same reason as the staff spec: this is meant
 * to run against production on every deploy, `lib/auth/login-throttle.ts` allows
 * 6 attempts per account per 5 minutes, and spending that budget on a negative
 * control would leave the demo member throttled for the next visitor. A
 * successful sign-in clears the buckets, so the positive journey is
 * self-cleaning. The rejection path is covered locally, where lockout is free
 * ("wrong password is rejected at the portal login", e2e/invite-flow.spec.ts).
 *
 * READ-ONLY. The portal can log a workout, and this deliberately does not: it
 * runs against production, where a written row is real data in the demo tenant
 * that nothing here would clean up.
 */

const demoMember = DEMO_ACCOUNTS.find(
  (account) => account.href === "/portal/login" && account.role === "Member",
);

if (!demoMember) {
  throw new Error(
    "No member demo account found in lib/demo-accounts.ts — the live portal " +
      "check has no credentials to verify. Add one, or set " +
      "VERIFY_MEMBER_EMAIL/VERIFY_MEMBER_PASSWORD.",
  );
}

const EMAIL = process.env.VERIFY_MEMBER_EMAIL?.trim() || demoMember.email;
const PASSWORD = process.env.VERIFY_MEMBER_PASSWORD || demoMember.password;

test.describe("live deployment: member portal", () => {
  /**
   * Credential-free: proves the portal guard is wired on the deployment at all.
   * If /portal served its content unauthenticated, the sign-in test below would
   * be measuring nothing.
   */
  test("the portal is guarded, and bounces to the member form", async ({ page }) => {
    const response = await page.goto("/portal", { waitUntil: "domcontentloaded" });

    expect(response?.status(), "/portal did not answer").toBe(200);
    await expect(page).toHaveURL(/\/portal\/login/);
    await expect(page.getByRole("heading", { name: "Member sign in" })).toBeVisible();
  });

  test("email + password sign-in reaches the portal", async ({ page }) => {
    // 1. The form a member lands on must actually render — not a 200 shell.
    const response = await page.goto("/portal/login", { waitUntil: "domcontentloaded" });
    expect(response?.status(), "/portal/login did not answer").toBe(200);
    await expect(page.getByRole("heading", { name: "Member sign in" })).toBeVisible();

    // 2. Submit real credentials through the real Server Action. This is the
    //    exact interaction the local suite hangs on.
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    // 3. The assertion that matters, and the one failing locally. Naming the
    //    causes here because the symptom is identical for all of them — and
    //    because a member stuck on "Signing in…" is the product not working.
    await expect(
      page,
      "member sign-in did not reach the portal — either the deployment cannot " +
        "reach its auth service, the token it issues carries no member_id claim " +
        "(so requireMember rejects a valid session), or these demo accounts " +
        "were never seeded into this environment (`npm run seed`)",
    ).toHaveURL(new RegExp(`${MEMBER_LANDING}$`), { timeout: 60_000 });

    // 4. The portal RENDERED, rather than an error boundary with a cheerful
    //    status. `ProgramView` always emits one of these two headings, and both
    //    sit behind requireMember plus an RLS-bound, member-scoped query — so
    //    either one proves the session was accepted down to the database.
    //    Accepting the empty state too keeps this honest on a deployment whose
    //    demo member has no assignment; step 5 is what pins the wedge.
    await expect(
      page.getByRole("heading", { name: /Your program|.+/ }).first(),
    ).toBeVisible();

    // 5. The wedge itself: a member sees an ASSIGNED program, not the empty
    //    state. The seed ships this end state ready to walk, so on a seeded
    //    deployment the empty copy appearing here is a real regression.
    await expect(
      page.getByText("No program has been assigned to you yet", { exact: false }),
      "the demo member has no assigned program — the product's core journey is " +
        "not demonstrable on this deployment (re-run `npm run seed`)",
    ).toHaveCount(0);

    // 6. Both session cookies were set on the live origin. The redirect alone
    //    could be a client-side navigation; these make the session survive the
    //    next request.
    const names = (await page.context().cookies()).map((cookie) => cookie.name);
    expect(names, "session cookies were not set").toEqual(
      expect.arrayContaining([ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE]),
    );

    // 7. The session works for a SUBSEQUENT request to the guarded route, which
    //    is the difference between "the action redirected" and "signed in".
    await page.goto("/portal", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(new RegExp(`${MEMBER_LANDING}$`));

    // 8. And the way out works, leaving the deployment as it was found.
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/portal\/login/, { timeout: 60_000 });
  });
});
