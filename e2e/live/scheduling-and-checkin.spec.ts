import { expect, test, type Page } from "@playwright/test";

import { DEMO_ACCOUNTS } from "../../lib/demo-accounts";

/**
 * Do class scheduling and front-desk check-in WORK on the running deployment?
 * (blueprint: "Class and session scheduling with per-class capacity limits and
 * waitlist auto-promotion" and "QR code or PIN-based check-in that a front-desk
 * staff member can action in under 3 seconds")
 *
 * WHY THIS EXISTS
 *
 * Both features have been reported round after round as "built but not live —
 * the code implements this but the running app doesn't serve it". Nothing in the
 * repository could confirm or refute that, because every existing check stops
 * short of these two screens:
 *
 *   - `scripts/deploy.mjs` verifies /, /login and /portal/login render. All three
 *     are static and database-free.
 *   - `e2e/live/staff-login.spec.ts` proves a staff session is established and
 *     that /dashboard renders — one route past the door.
 *   - The vitest suites and ./e2e prove the CODE is right against a throwaway
 *     Postgres. They can say nothing about what the deployment serves.
 *
 * So this drives the two screens themselves, signed in, against the real
 * deployment. It runs under `playwright.live.config.ts` (starts no servers) and
 * is excluded from the default ./e2e run, whose stubbed auth has no demo
 * accounts.
 *
 * IT ALSO CATCHES THE STATE THAT PRODUCED THE FINDING. On 2026-08-20 the code
 * for both features was deployed and correct, but every seeded demo class had
 * slipped into the PAST (the timetable is seeded relative to the seed date and
 * nothing rolls it forward), so /dashboard/classes served its empty state and
 * the portal had nothing to book. To anyone evaluating the app that is
 * indistinguishable from "not live" — which is exactly how it was reported. The
 * capacity assertion below fails in that state instead of passing on an empty
 * page, so a stale timetable can no longer read as a healthy deployment.
 *
 * WHAT IT WRITES. The check-in journey performs a real check-in and then a real
 * check-out of the demo member, which is what proves the kiosk works rather than
 * merely renders. The pair is self-closing — it leaves one completed visit in
 * today's feed and the occupancy count exactly as it found it — which is why
 * this is safe to run on every deploy. Nothing else here mutates anything.
 */

const staff = DEMO_ACCOUNTS.find(
  (account) => account.href === "/login" && account.role === "Owner",
);
const portalMember = DEMO_ACCOUNTS.find((account) => account.href === "/portal/login");

if (!staff || !portalMember) {
  throw new Error(
    "lib/demo-accounts.ts has no staff Owner and/or member account — the live " +
      "scheduling/check-in verification has no credentials and no member to scan.",
  );
}

const EMAIL = process.env.VERIFY_STAFF_EMAIL?.trim() || staff.email;
const PASSWORD = process.env.VERIFY_STAFF_PASSWORD || staff.password;
/** Identifies the member row to scan; the roster shows the email under the name. */
const MEMBER_EMAIL = process.env.VERIFY_MEMBER_EMAIL?.trim() || portalMember.email;

/**
 * A PIN that belongs to nobody, for the negative case. Six digits (the length
 * `lib/checkin.ts` issues) so it exercises the real lookup rather than input
 * validation, and it writes nothing whatever the answer is.
 */
const UNKNOWN_PIN = "000000";

/**
 * Serial, on ONE page, because sign-in is throttled per account
 * (lib/auth/login-throttle.ts allows 6 attempts per 5 minutes) and this spec
 * shares that budget with e2e/live/staff-login.spec.ts. One session for the
 * whole file keeps both well inside it.
 */
test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  // `exact` matters: a deployment carrying the demo sign-in shortcuts also has
  // "Sign in as Owner"/"Sign in as Trainer" buttons, and a substring match is
  // ambiguous against them.
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page,
    "staff sign-in did not reach the dashboard — see e2e/live/staff-login.spec.ts, " +
      "which diagnoses that failure on its own",
  ).toHaveURL(/\/dashboard$/, { timeout: 60_000 });
});

test.afterAll(async () => {
  await page?.close();
});

test.describe("live deployment: class scheduling", () => {
  test("the timetable serves with per-class capacity and a waitlist roster", async () => {
    await page.goto("/dashboard/classes", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/dashboard\/classes$/);
    await expect(page.getByRole("heading", { name: "Classes" })).toBeVisible();
    // The way a gym adds a session. Its absence means the page rendered an error
    // boundary or a shell rather than the feature.
    await expect(page.getByRole("button", { name: "Schedule a class" })).toBeVisible();

    // Per-class capacity, on the row: "3/12 booked". This is the assertion that
    // separates "the feature is live" from "the page loads and lists nothing" —
    // see the note above about the timetable slipping into the past.
    const capacityBadge = page.getByText(/^\d+\/\d+ booked$/).first();
    await expect(
      capacityBadge,
      "no upcoming class is listed, so per-class capacity and the waitlist cannot " +
        "be seen or exercised by anyone evaluating this deployment. The classes " +
        "feature is deployed but demonstrates as nothing. Re-run `npm run seed` " +
        "against this environment: the demo timetable is seeded relative to the " +
        "seed date (scripts/seed.mjs, DEMO_CLASSES) and has fallen into the past.",
    ).toBeVisible();

    // Into the roster, which is where capacity and the waitlist are managed.
    await capacityBadge.click();
    await expect(page).toHaveURL(/\/dashboard\/classes\/[0-9a-f-]{36}$/);
    // "Booked (0/12)" — the capacity limit itself, from the class row.
    await expect(page.getByRole("heading", { name: /^Booked \(\d+\/\d+\)$/ })).toBeVisible();
    // Auto-promotion is a server-side consequence of a cancellation
    // (lib/classes.ts), so what is verifiable from outside is that the surface
    // which performs it is served. Either state counts: an occupied waitlist
    // states the promotion rule, an empty one says so — what must never happen
    // is the section being absent.
    const waitlist = page.locator("section").filter({
      has: page.getByRole("heading", { name: /^Waitlist \(\d+\)$/ }),
    });
    await expect(waitlist).toBeVisible();
    await expect(waitlist).toContainText(
      /No one is waitlisted\.|promotes the longest-waiting member here automatically/,
    );
  });
});

test.describe("live deployment: front-desk check-in", () => {
  test("the kiosk serves, and rejects a PIN that belongs to nobody", async () => {
    await page.goto("/dashboard/checkin", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/dashboard\/checkin$/);
    await expect(page.getByRole("heading", { name: "Check-in" })).toBeVisible();
    await expect(page.getByText("In the gym right now")).toBeVisible();

    // A rejection proves the Server Action reached the database and ran the
    // lookup — a kiosk whose form posts into a void answers nothing at all —
    // and it writes no row whatever the outcome.
    await page.getByLabel("Scan QR or type PIN").fill(UNKNOWN_PIN);
    await page.getByRole("button", { name: "Check in / out" }).click();
    // By text, not by role: Next's route announcer is also role="alert".
    await expect(page.getByText("No member with that PIN.")).toBeVisible({
      timeout: 30_000,
    });
  });

  test("a member's PIN checks them in, and the same PIN checks them out", async () => {
    // 1. Read the demo member's PIN the way the front desk does — off their
    //    profile — rather than restating a value the environment may not have.
    await page.goto("/dashboard/members", { waitUntil: "domcontentloaded" });
    await page.getByRole("link").filter({ hasText: MEMBER_EMAIL }).first().click();
    await expect(page).toHaveURL(/\/dashboard\/members\/[0-9a-f-]{36}$/);
    const memberName = (await page.getByRole("heading", { level: 1 }).innerText()).trim();

    const pin = (
      await page.locator("section", { hasText: "Check-in PIN" }).locator("p.font-mono").first().innerText()
    ).trim();
    expect(
      pin,
      `${MEMBER_EMAIL} has no check-in PIN on this deployment, so nobody can be ` +
        "checked in by PIN. Issue one from their profile (\"Generate PIN\") or " +
        "re-run `npm run seed`.",
    ).toMatch(/^\d{6}$/);

    // 2. Arrival. Timed because the blueprint's requirement is a front-desk
    //    action completing in seconds; the ceiling is generous enough to survive
    //    a cold serverless container while still failing a kiosk that hangs, and
    //    the measured value is logged so the real number is visible.
    await page.goto("/dashboard/checkin", { waitUntil: "domcontentloaded" });
    const started = Date.now();
    await page.getByLabel("Scan QR or type PIN").fill(pin);
    await page.getByRole("button", { name: "Check in / out" }).click();
    const confirmation = page.getByRole("status");
    await expect(confirmation).toContainText("Checked in", { timeout: 30_000 });
    console.log(`[live] PIN check-in confirmed in ${Date.now() - started}ms`);
    expect(Date.now() - started, "the check-in round trip took too long to be usable at a front desk").toBeLessThan(
      10_000,
    );

    // 3. Departure, from the same single input — which is also what leaves this
    //    deployment's occupancy count exactly as this test found it.
    await page.getByLabel("Scan QR or type PIN").fill(pin);
    await page.getByRole("button", { name: "Check in / out" }).click();
    await expect(confirmation).toContainText("Checked out", { timeout: 30_000 });

    // 4. And the visit is on today's feed — the record the desk reads — with
    //    both ends of it and the method it was recorded by.
    await page.goto("/dashboard/checkin", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
    const visit = page.getByRole("listitem").filter({ hasText: memberName }).first();
    // Arrival time, departure time, method — the separators between them are
    // typographic (en dash, middot) and not worth pinning.
    await expect(visit).toContainText(/\d{2}:\d{2}\D+\d{2}:\d{2}\D+PIN/);
  });
});
