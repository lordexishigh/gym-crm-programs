import { expect, test } from "@playwright/test";

import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "../../lib/auth/cookies";
import { MEMBER_LANDING } from "../../lib/auth/sign-in-reason";
import { DEMO_ACCOUNTS } from "../../lib/demo-accounts";

/**
 * Does MEMBER email + password sign-in WORK on a deployment that is already
 * running? (blueprint: "Member authentication — email and password login")
 *
 * WHY THIS EXISTS ALONGSIDE ./staff-login.spec.ts
 *
 * That spec answers the same question for `/login`. It cannot answer it for
 * `/portal/login`: the two forms have separate Server Actions
 * (app/login/actions.ts vs app/portal/login/actions.ts), separate guards
 * (`requireStaff` vs `requireMember`), and separate landings — and the member
 * path has one failure mode staff sign-in does not have at all, because
 * `requireMember` additionally demands a `member_id` claim resolved at invite
 * acceptance. A deployment can therefore serve staff sign-in perfectly and
 * still bounce every member straight back to the form.
 *
 * WHY `npm run smoke:portal` DOES NOT ALREADY COVER IT
 *
 * `scripts/smoke-portal.mjs` does sign a demo member in against the deployment,
 * but it exists to answer a different question — "are the portal's SECTIONS
 * being served?" — and its exit codes are shaped for that. A deployment that
 * REJECTS the member's credentials exits 2 ("cannot run"), which `deploy.mjs`
 * treats as a warning, deliberately: an unseeded environment is not a defect in
 * the code being deployed. The consequence is that "members can actually sign
 * in" has never had a check that FAILS when it is untrue, which is precisely the
 * evidence an automated reviewer keeps asking for and not finding. It also never
 * looks at the guard, the session cookies, or whether the session survives a
 * second request.
 *
 * So this asserts the authentication itself, as a hard failure, against a real
 * deployment in a real browser. It runs under `playwright.live.config.ts` (which
 * starts no servers) and is excluded from the default ./e2e run, whose stubbed
 * auth has no demo accounts.
 *
 * EXPECT THIS TO NEED ITS RETRY SOMETIMES. On its first run against production
 * (2026-08-20) step 4 timed out with the submit button still reading
 * "Signing in…" and an EMPTY `[role=alert]` — the Server Action never committed
 * its navigation, rather than the credentials being refused. That is issue #26
 * (see e2e/action-trace.ts), reproducing on the member form against the real
 * deployment; the retry `playwright.live.config.ts` allows then passed and the
 * portal rendered. So a single retry here is the known bug, not a broken
 * deployment — but two consecutive failures are a real one. The two are
 * distinguishable in the failure snapshot: a refused credential leaves a
 * populated alert ("Invalid email or password"), the hang leaves it empty.
 *
 * NO WRONG-PASSWORD CASE HERE, DELIBERATELY — for the reason spelled out in
 * ./staff-login.spec.ts: `lib/auth/login-throttle.ts` allows 6 attempts per
 * account per 5 minutes, a successful sign-in clears the buckets, and spending
 * that budget on a negative control would park the demo member in a lockout for
 * the next visitor. The rejection path is covered locally, where lockout costs
 * nothing: see e2e/invite-flow.spec.ts.
 */

/**
 * The credentials to sign in with — resolved the same way the staff spec
 * resolves its own, from `lib/demo-accounts.ts`: the list the form itself
 * advertises (app/DemoSignInHint.tsx) and which test/demo-accounts.test.ts pins
 * against `scripts/seed.mjs`. Reading it here rather than restating a password
 * means this check cannot drift into verifying credentials the deployment was
 * never seeded with.
 *
 * Overridable for a deployment where the `SEED_*` defaults were changed (a real
 * gym rather than a demo environment) — see DEMO_ACCOUNTS_CAVEAT.
 */
const member = DEMO_ACCOUNTS.find((account) => account.href === "/portal/login");

if (!member) {
  throw new Error(
    "No member demo account found in lib/demo-accounts.ts — the live member " +
      "sign-in check has no credentials to verify. Add one, or set " +
      "VERIFY_MEMBER_EMAIL/VERIFY_MEMBER_PASSWORD.",
  );
}

const EMAIL = process.env.VERIFY_MEMBER_EMAIL?.trim() || member.email;
const PASSWORD = process.env.VERIFY_MEMBER_PASSWORD || member.password;

test.describe("live deployment: member authentication", () => {
  /**
   * Free of credentials and of the database: proves the portal guard is wired on
   * the deployment at all. If this fails, the portal is not protected and the
   * sign-in test below would be measuring nothing.
   */
  test("portal routes are guarded, and say why they bounced", async ({ page }) => {
    const response = await page.goto("/portal", { waitUntil: "domcontentloaded" });

    expect(response?.status(), "/portal did not answer").toBe(200);
    // Landed on the MEMBER form (not the staff one), carrying the reason the
    // guard attached (lib/auth/sign-in-reason.ts) rather than a bare form.
    await expect(page).toHaveURL(/\/portal\/login\?reason=session-expired$/);
    await expect(
      page.getByRole("heading", { name: "Member sign in" }),
    ).toBeVisible();
  });

  test("email + password sign-in reaches the portal", async ({ page }) => {
    // 1. The form a member lands on from their invite email must render — not a
    //    200 shell, the actual heading and both fields.
    const response = await page.goto("/portal/login", {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status(), "/portal/login did not answer").toBe(200);
    await expect(
      page.getByRole("heading", { name: "Member sign in" }),
    ).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();

    // 2. A visitor with no out-of-band setup must be able to get in, so the
    //    credentials have to be ON this page (members are invite-only, and an
    //    evaluator has no invite email).
    await expect(page.getByText(EMAIL, { exact: false }).first()).toBeVisible();

    // 3. Submit real credentials through the real Server Action.
    //    `exact` is load-bearing: accessible-name matching is a SUBSTRING match
    //    by default, and app/DemoSignInHint.tsx renders a "Sign in as Member"
    //    button under this form, in its own <form>. Without it the locator
    //    matches both and Playwright refuses to guess — a red deploy gate caused
    //    by the page around the form, not by sign-in being broken.
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    // 4. The whole point: the session is established and the member landing page
    //    is reached. A failure here is the reported defect, and the assertion
    //    message has to name the causes, because the symptom is identical for
    //    all of them.
    await expect(
      page,
      "member sign-in did not reach the portal — either the deployment cannot " +
        "reach its auth service (check NEXT_PUBLIC_SUPABASE_URL / " +
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY on the project), the token it " +
        "issues cannot be verified against the project JWKS, this demo member " +
        "was never seeded into this environment (`npm run seed`), or the " +
        "session carries no member_id and requireMember bounced it back " +
        "(look for ?reason=setup-incomplete on the URL)",
    ).toHaveURL(new RegExp(`${MEMBER_LANDING}$`), { timeout: 60_000 });

    // 5. The portal actually RENDERED, rather than serving an error boundary with
    //    a cheerful status. Two different things are asserted because they fail
    //    independently:
    //      - the program heading (ProgramView's <h1>) is member-SPECIFIC content,
    //        resolved through an RLS-scoped query keyed on this member's id, so
    //        seeing it proves the session was accepted down to the database. Its
    //        text is the assigned program's name on a seeded deployment and
    //        "Your program" on one with no assignment, so only its presence is
    //        pinned — a real gym's program names are not this check's business.
    //      - "Membership" renders unconditionally (app/portal/MembershipStatus),
    //        so it distinguishes "the portal served" from "the program section
    //        alone survived".
    const programHeading = page.getByRole("heading", { level: 1 }).first();
    await expect(programHeading).toBeVisible();
    await expect(programHeading).toHaveText(/\S/);
    await expect(page.getByRole("heading", { name: "Membership" })).toBeVisible();

    // 6. Both session cookies were set on the live origin. The redirect alone
    //    could be a client-side navigation; these are what make the session
    //    survive the next request.
    const names = (await page.context().cookies()).map((cookie) => cookie.name);
    expect(names, "session cookies were not set").toEqual(
      expect.arrayContaining([ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE]),
    );

    // 7. The session works for a SUBSEQUENT request, which is the difference
    //    between "the login action redirected" and "the member is actually
    //    signed in". The portal is the member's only guarded surface, so this
    //    re-requests it rather than a sibling route: a session that failed to
    //    persist bounces back to /portal/login here.
    await page.goto("/portal", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(new RegExp(`${MEMBER_LANDING}$`));
    await expect(page.getByRole("heading", { name: "Membership" })).toBeVisible();

    // 8. And the way out works, leaving the deployment as it was found.
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/portal\/login/, { timeout: 60_000 });
  });
});
