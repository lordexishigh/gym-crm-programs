import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { captureResponsive } from "./capture";
import { recordServerActionResponses } from "./action-trace";

/**
 * Journey test: staff sign-in → dashboard → add a member → author a program →
 * assign it → confirm the counts → log out.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE INVITE JOURNEY
 *
 * `invite-flow.spec.ts` walks the MEMBER end of the product (invite → accept →
 * portal). Nothing walked the STAFF end, and that gap was not academic: a
 * build-quality review of this project reported "no authenticated user journey
 * was run, leaving the entire staff-side product (dashboard, member management,
 * program authoring, program assignment) unverified". Everything staff-side was
 * covered only by unit tests against isolated components and Server Actions —
 * which cannot show that a real session, real RLS, and the real forms compose
 * into a usable product.
 *
 * So this drives the four staff capabilities the product claims, in the order a
 * trainer actually performs them, against the BUILT app and a real Postgres:
 *
 *   1. the /login form establishing a staff session that /dashboard accepts
 *      (the loop this used to fall into is documented in app/login/actions.ts),
 *   2. member management — create a member, see them on the roster,
 *   3. program authoring — the builder serialising exercise drafts into a saved
 *      program,
 *   4. program assignment — and the counts on the program list and the overview
 *      KPIs actually moving as a result.
 *
 * Step 0 is deliberately the UNAUTHENTICATED case: a guard that bounces a
 * visitor to /login without saying why is indistinguishable from a sign-in that
 * silently did nothing, so the reason banner is asserted, not just the URL.
 *
 * DB safety: fixtures are seeded through DATABASE_URL, so — mirroring
 * test/setup/db-safety.ts and the invite journey — the suite runs only when that
 * URL points at a LOCAL host (CI's throwaway postgres:16). In our own GitHub
 * workflow a missing/non-local DATABASE_URL is a config bug, so there it fails
 * instead of silently skipping.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLocalDatabase(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const dbUsable = Boolean(DATABASE_URL) && isLocalDatabase(DATABASE_URL);

if (process.env.GITHUB_ACTIONS && !dbUsable) {
  throw new Error(
    "[e2e] CI run has no local DATABASE_URL — the staff journey would be " +
      "silently skipped. Provision the throwaway Postgres service (see ci.yml).",
  );
}

/**
 * The GoTrue stand-in Playwright starts (see playwright.config.ts). The staff
 * auth user is provisioned through its admin API rather than through the app,
 * because the app has no staff sign-up by design — staff accounts come from
 * `scripts/seed.mjs` in a real deployment. Provisioning it the same way the seed
 * does is what makes the sign-in below exercise the real password grant.
 */
const AUTH_STUB_URL = process.env.AUTH_STUB_URL ?? "http://127.0.0.1:54321";

// Unique-per-run fixture identifiers so retries/re-runs never collide.
const runId = randomUUID().slice(0, 8);
const staffEmail = `e2e-owner-${runId}@example.test`;
const staffPassword = "e2e-Sup3r-secret!";
const gymName = `E2E Staff Gym ${runId}`;
const memberName = `E2E Roster Member ${runId}`;
const memberEmail = `e2e-roster-${runId}@example.test`;
const programName = `E2E Authored Program ${runId}`;
const exerciseName = `E2E Front Squat ${runId}`;

let db: Client;
let gymId: string;
let authUserId: string;

/** Create the staff auth user in the GoTrue stub, with the app's own claims. */
async function createStaffAuthUser(tenantId: string): Promise<string> {
  const res = await fetch(`${AUTH_STUB_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: staffEmail,
      password: staffPassword,
      email_confirm: true,
      // The claims lib/identity.ts reads. `app_role: "staff"` is what makes
      // /login accept the session and /portal reject it.
      app_metadata: { tenant_id: tenantId, app_role: "staff" },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `[e2e] auth stub refused to create the staff user (${res.status}): ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new Error("[e2e] auth stub returned no user id");
  return body.id;
}

/** Sign in at /login and land on the dashboard. */
async function signInAsStaff(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(staffEmail);
  await page.getByLabel("Password").fill(staffPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
}

test.describe("staff journey", () => {
  test.skip(!dbUsable, "DATABASE_URL must point at a local throwaway Postgres");

  // Attaches each Server Action's flight payload — the one input issue #26's
  // retained trace cannot show, since traces store GET bodies but no POST ones.
  test.beforeEach(async ({ page }) => {
    // Awaited: the binding and init script must be registered before the first
    // navigation. Firing them with `void` was one of two candidate reasons the
    // recorder attached nothing on the run where #26 reproduced.
    await recordServerActionResponses(page);
  });

  test.beforeAll(async () => {
    db = new Client({ connectionString: DATABASE_URL });
    await db.connect();

    const gym = await db.query(
      `insert into gym (name, slug) values ($1, $2) returning id`,
      [gymName, `e2e-staff-gym-${runId}`],
    );
    gymId = gym.rows[0].id;

    authUserId = await createStaffAuthUser(gymId);

    // The staff row behind the session. Seeded as an OWNER so the journey also
    // covers the owner/trainer split: the "Plans" nav entry is owner-only (see
    // app/dashboard/layout.tsx), and its presence is the visible proof that
    // `users.role` was resolved under RLS for this session.
    await db.query(
      `insert into users (tenant_id, email, full_name, role, auth_user_id)
       values ($1, $2, $3, 'owner', $4)`,
      [gymId, staffEmail, "E2E Owner", authUserId],
    );
  });

  test.afterAll(async () => {
    // Children (users, member, program, exercise, assignment) cascade from gym.
    if (db) {
      if (gymId) await db.query(`delete from gym where id = $1`, [gymId]);
      await db.end();
    }
    if (authUserId) {
      await fetch(`${AUTH_STUB_URL}/auth/v1/admin/users/${authUserId}`, {
        method: "DELETE",
      }).catch(() => {});
    }
  });

  test("sign in → dashboard → add member → build program → assign → log out", async ({
    page,
  }) => {
    // 0. The dashboard is gated, and the bounce EXPLAINS itself. A login form
    //    reached with no message reads as "sign-in silently did nothing" — see
    //    lib/auth/sign-in-reason.ts.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login\?reason=session-expired$/);
    await expect(page.getByText(/Your session has ended/)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Staff sign in" }),
    ).toBeVisible();

    // 1. Sign in. This is the step that had never been confirmed end to end:
    //    the action verifies the token, checks the destination guard's own
    //    identity mapping, sets the cookies, and redirects.
    await signInAsStaff(page);

    // 2. The dashboard renders the gym's own data under RLS. A fresh gym has
    //    nothing in it, and the overview must still be a usable page rather
    //    than a blank one.
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await expect(page.getByText(gymName)).toBeVisible();
    // Owner-only nav (see the fixture note above). `exact` is load-bearing:
    // accessible-name matching is case-insensitive and substring by default, so
    // a loose "Plans" would also match the Programs KPI tile ("…Training plans
    // built") and fail strict-mode with two hits.
    await expect(
      page.getByRole("link", { name: "Plans", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('section[aria-label="Gym at a glance"]'),
    ).toContainText("0 active");
    await captureResponsive(page, "06-staff-dashboard");

    // 3. MEMBER MANAGEMENT — reached the way a trainer reaches it, from the
    //    overview's own quick action rather than by typing a URL.
    await page.getByRole("link", { name: "Add a member" }).click();
    await expect(page).toHaveURL(/\/dashboard\/members\/new$/);
    await page.getByLabel("Full name").fill(memberName);
    await page.getByLabel("Email").fill(memberEmail);
    await page.getByRole("button", { name: "Create member" }).click();

    // The action redirects to the new member's detail page.
    await expect(page).toHaveURL(/\/dashboard\/members\/[0-9a-f-]{36}$/, {
      timeout: 30_000,
    });
    await expect(page.getByRole("heading", { name: memberName })).toBeVisible();

    // …and the roster lists them.
    await page.getByRole("link", { name: "← Members" }).click();
    await expect(page).toHaveURL(/\/dashboard\/members$/);
    await expect(page.getByText(memberName)).toBeVisible();
    await expect(page.getByText(memberEmail)).toBeVisible();

    // 4. PROGRAM AUTHORING — the builder holds exercise rows in client state and
    //    serialises them into one hidden field on submit, so authoring is only
    //    proven by driving the real form: adding a row, typing into unnamed
    //    inputs, and finding the values persisted afterwards.
    await page.getByRole("link", { name: "Programs", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard\/programs$/);

    // Authoring now opens in a dialog on the list page rather than navigating to
    // /dashboard/programs/new (feedback-2026-08: "make all the create X pages
    // into a popup, so the user never leaves the main data"). The route still
    // exists and still renders the same builder — it is just no longer the way
    // the CTA gets there, so this drives the dialog instead.
    await page.getByRole("button", { name: "New program" }).click();
    const builder = page.getByRole("dialog", { name: "New program" });
    await expect(builder).toBeVisible();
    // Still on the list — that is the point of the change.
    await expect(page).toHaveURL(/\/dashboard\/programs$/);

    // Scoped to the dialog so these can never accidentally resolve against the
    // list behind it.
    await builder.getByLabel("Program name").fill(programName);
    await builder
      .getByLabel("Description")
      .fill("Authored by the staff journey.");
    await builder.getByRole("button", { name: "+ Add exercise" }).click();
    await builder.getByLabel("Name", { exact: true }).fill(exerciseName);
    await builder.getByLabel("Sets").fill("4");
    await builder.getByLabel("Reps").fill("6");
    await builder.getByLabel("Rest").fill("150s");
    await builder.getByRole("button", { name: "Create program" }).click();

    // Redirects to the new program's detail page, which re-reads it from the DB.
    await expect(page).toHaveURL(/\/dashboard\/programs\/[0-9a-f-]{36}$/, {
      timeout: 30_000,
    });
    await expect(page.getByRole("heading", { name: programName })).toBeVisible();
    // The exercise survived the serialise → Server Action → insert → re-read
    // round trip with its numbers intact.
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
      exerciseName,
    );
    await expect(page.getByLabel("Sets")).toHaveValue("4");
    await expect(page.getByLabel("Reps")).toHaveValue("6");
    await expect(page.getByLabel("Rest")).toHaveValue("150s");

    // 5. PROGRAM ASSIGNMENT — the wedge feature's staff half. The picker is
    //    populated from the RLS-scoped member list, so the member created above
    //    is selectable here only because both resolved to the same tenant.
    const assignPanel = page.locator("section", {
      has: page.getByRole("heading", { name: "Assign to members" }),
    });
    await expect(assignPanel).toContainText("Not assigned to anyone yet.");
    await assignPanel.getByLabel("Member").selectOption({ label: memberName });
    await assignPanel.getByRole("button", { name: "Assign" }).click();
    await expect(assignPanel.getByText("Program assigned.")).toBeVisible({
      timeout: 30_000,
    });
    // `revalidatePath` re-renders the panel from the DB, so the member appearing
    // under "Currently assigned" is a re-read, not optimistic client state.
    await expect(
      assignPanel.getByRole("listitem").filter({ hasText: memberName }),
    ).toBeVisible();
    await expect(assignPanel).not.toContainText("Not assigned to anyone yet.");
    await captureResponsive(page, "07-staff-program-assigned");

    // 6. The work is visible where staff look for it. The program list's counts
    //    are independent sub-queries, so they confirm the exercise and the
    //    assignment landed as rows rather than only as page state.
    await page.getByRole("link", { name: "← Programs" }).click();
    await expect(page).toHaveURL(/\/dashboard\/programs$/);
    const programRow = page.getByRole("listitem").filter({ hasText: programName });
    await expect(programRow).toContainText("1 exercise");
    await expect(programRow).toContainText("1 assigned");

    // …and the overview KPIs, which were all zero at step 2, now reflect it.
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    const kpis = page.locator('section[aria-label="Gym at a glance"]');
    await expect(kpis).toContainText("1 active");
    await expect(kpis).toContainText("Programs in members' hands");

    // The old "Active members" tile (hint: "of 1 total") is gone — it restated
    // the two numbers the Members tile already shows and read as live presence
    // while meaning membership status. Its slot now holds real occupancy, which
    // is 0 here because this journey never checks anyone in at the kiosk.
    const occupancy = kpis.getByRole("link", { name: /In the gym now/ });
    await expect(occupancy).toContainText("0");

    // 7. Log out — the session ends and the dashboard is gated again.
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/login$/, { timeout: 30_000 });
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login\?reason=session-expired$/);
  });

  test("a staff account is refused at the member portal login", async ({
    page,
  }) => {
    // The two sign-in surfaces are separate audiences. Entering staff
    // credentials on the portal form must say so rather than half-signing the
    // visitor in and stranding them on a guard redirect.
    await page.goto("/portal/login");
    await page.getByLabel("Email").fill(staffEmail);
    await page.getByLabel("Password").fill(staffPassword);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(
      page.getByText("This is a staff account — please use the staff sign-in page."),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/portal\/login$/);
  });

  test("a signed-in staff session is redirected away from the member portal", async ({
    page,
  }) => {
    await signInAsStaff(page);
    // `requireMember` sends a staff session to the dashboard rather than to a
    // portal it can never resolve a member row for.
    await page.goto("/portal");
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  });
});
