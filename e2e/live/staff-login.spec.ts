import { expect, test } from "@playwright/test";

import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "../../lib/auth/cookies";
import { STAFF_LANDING } from "../../lib/auth/sign-in-reason";
import { DEMO_ACCOUNTS } from "../../lib/demo-accounts";

/**
 * Does staff email + password sign-in WORK on a deployment that is already
 * running? (blueprint: "Staff authentication — email and password login")
 *
 * WHY THIS EXISTS, AND WHY IT IS SEPARATE FROM ./e2e
 *
 * An automated review keeps reporting this blueprint item as "built but not live
 * — the code implements it but the running app doesn't serve it". Nothing in the
 * repository could answer that, because every existing check stops one step
 * short of the claim:
 *
 *   - `scripts/deploy.mjs` verifies the entry routes RENDER. Its own comment
 *     says why that is not enough: "/login that RENDERS is not a /login that
 *     WORKS". /login and /portal/login are statically prerendered, so a
 *     deployment with a rotated Supabase key, a paused project, or an unseeded
 *     database serves them flawlessly and then refuses every credential.
 *   - `/api/health` reports `auth: "configured"`, which only means two
 *     environment variables are non-empty — not that any credential
 *     authenticates.
 *   - `e2e/invite-flow.spec.ts` does drive a real sign-in, but against a LOCAL
 *     build wired to the GoTrue stand-in (e2e/auth-stub.mjs) and a throwaway
 *     Postgres. It proves the code is correct; it can say nothing about what the
 *     deployment serves.
 *
 * So the gap was never the feature — it was that "it is live" had no artifact
 * behind it. This spec closes it by driving the real public sign-in path in a
 * real browser against a real deployment: the same three things a reviewer does
 * by hand, asserted. It runs under `playwright.live.config.ts` (which starts no
 * servers) and is excluded from the default ./e2e run, whose stubbed auth has no
 * demo accounts.
 *
 * NO WRONG-PASSWORD CASE HERE, DELIBERATELY. This is intended to run against
 * production on every deploy, and `lib/auth/login-throttle.ts` allows 6 attempts
 * per account per 5 minutes. Spending that budget on a negative control would
 * park the demo account in a throttled state for the next visitor — breaking the
 * exact thing this verifies. A successful sign-in CLEARS both buckets, so the
 * positive journey is self-cleaning and safe to repeat. The rejection path is
 * covered locally, where lockout costs nothing: see the "wrong password is
 * rejected" test in e2e/invite-flow.spec.ts.
 */

/**
 * The credentials to sign in with.
 *
 * Sourced from `lib/demo-accounts.ts` — the same list the sign-in forms
 * themselves advertise (app/DemoSignInHint.tsx) and which
 * test/demo-accounts.test.ts pins against `scripts/seed.mjs`. Reading it here
 * rather than restating a password means this check cannot drift into verifying
 * credentials the deployment was never seeded with.
 *
 * Overridable for a deployment where the `SEED_*` defaults were changed (a real
 * gym rather than a demo environment) — see DEMO_ACCOUNTS_CAVEAT.
 */
const owner = DEMO_ACCOUNTS.find(
  (account) => account.href === "/login" && account.role === "Owner",
);

if (!owner) {
  throw new Error(
    "No staff demo account found in lib/demo-accounts.ts — the live sign-in " +
      "check has no credentials to verify. Add one, or set " +
      "VERIFY_STAFF_EMAIL/VERIFY_STAFF_PASSWORD.",
  );
}

const EMAIL = process.env.VERIFY_STAFF_EMAIL?.trim() || owner.email;
const PASSWORD = process.env.VERIFY_STAFF_PASSWORD || owner.password;

test.describe("live deployment: staff authentication", () => {
  /**
   * Free of credentials and of the database: proves the guard is wired on the
   * deployment at all. If this fails, the dashboard is not protected and the
   * sign-in test below would be measuring nothing.
   */
  test("staff routes are guarded, and say why they bounced", async ({ page }) => {
    const response = await page.goto("/dashboard", { waitUntil: "domcontentloaded" });

    expect(response?.status(), "/dashboard did not answer").toBe(200);
    // Landed on the staff form, carrying the reason the guard attached
    // (lib/auth/sign-in-reason.ts) rather than a bare, unexplained form.
    await expect(page).toHaveURL(/\/login\?reason=session-expired$/);
    await expect(
      page.getByRole("heading", { name: "Staff sign in" }),
    ).toBeVisible();
  });

  test("email + password sign-in reaches the dashboard", async ({ page }) => {
    // 1. The form the reviewer lands on must render — not a 200 shell, the
    //    actual heading and both fields.
    const response = await page.goto("/login", { waitUntil: "domcontentloaded" });
    expect(response?.status(), "/login did not answer").toBe(200);
    await expect(
      page.getByRole("heading", { name: "Staff sign in" }),
    ).toBeVisible();

    // 2. A visitor with no out-of-band setup must be able to get in, so the
    //    credentials have to be ON this page (the app has no public sign-up).
    await expect(page.getByText(EMAIL, { exact: false }).first()).toBeVisible();

    // 3. Submit real credentials through the real Server Action.
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    // 4. The whole point: the session is established and the staff landing page
    //    is reached. A failure here is the reported defect, and the assertion
    //    message has to name the causes, because the symptom is identical for
    //    all of them.
    await expect(
      page,
      "sign-in did not reach the dashboard — either the deployment cannot reach " +
        "its auth service (check NEXT_PUBLIC_SUPABASE_URL / " +
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY on the project), the token it " +
        "issues cannot be verified against the project JWKS, or these demo " +
        "accounts were never seeded into this environment (`npm run seed`)",
    ).toHaveURL(new RegExp(`${STAFF_LANDING}$`), { timeout: 60_000 });

    // 5. The dashboard actually RENDERED, rather than serving an error boundary
    //    with a cheerful status. This content is behind requireStaff and a
    //    tenant-scoped, RLS-bound query, so seeing it proves the session was
    //    accepted all the way down to the database.
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await expect(page.getByText("Members", { exact: true }).first()).toBeVisible();

    // 6. Both session cookies were set on the live origin. The redirect alone
    //    could be a client-side navigation; these are what make the session
    //    survive the next request.
    const names = (await page.context().cookies()).map((cookie) => cookie.name);
    expect(names, "session cookies were not set").toEqual(
      expect.arrayContaining([ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE]),
    );

    // 7. The session works for a SUBSEQUENT request to a different guarded
    //    route, which is the difference between "the login action redirected"
    //    and "staff are actually signed in".
    await page.goto("/dashboard/members", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/dashboard\/members$/);

    // 8. And the way out works, leaving the deployment as it was found.
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 60_000 });
  });
});
