import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { captureResponsive } from "./capture";
import {
  flushFlightRecords,
  recordServerActionResponses,
} from "./action-trace";

/**
 * Journey test: invite → accept → login → portal view (the complete member
 * onboarding path the unit/a11y suites deliberately stub out).
 *
 * It exercises, against the BUILT app and a real Postgres:
 *   - the invite-accept page validating a raw token (hash lookup),
 *   - acceptInviteAction provisioning the auth user (GoTrue stub), consuming
 *     the invite, linking the member row, and auto-signing-in,
 *   - the redirect to /portal and the RLS-scoped portal render,
 *   - logout, then a fresh /portal/login password sign-in back to the portal.
 *
 * DB safety: fixtures are seeded through DATABASE_URL, so — mirroring
 * test/setup/db-safety.ts — the suite runs only when that URL points at a
 * LOCAL host (CI's throwaway postgres:16). In our own GitHub workflow a
 * missing/non-local DATABASE_URL is a config bug, so there it fails instead
 * of silently skipping.
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
    "[e2e] CI run has no local DATABASE_URL — the invite journey would be " +
      "silently skipped. Provision the throwaway Postgres service (see ci.yml).",
  );
}

// Unique-per-run fixture identifiers so retries/re-runs never collide.
const runId = randomUUID().slice(0, 8);
const memberEmail = `e2e-member-${runId}@example.test`;
const memberPassword = "e2e-Sup3r-secret!";
const gymName = `E2E Gym ${runId}`;
const programName = `E2E Strength ${runId}`;
const rawInviteToken = randomBytes(32).toString("base64url");

let db: Client;
let gymId: string;

test.describe("member onboarding journey", () => {
  test.skip(!dbUsable, "DATABASE_URL must point at a local throwaway Postgres");

  // Recorded on the member end too: #26's victim rotates between staff and
  // member journeys, so whichever one hangs, its payload is already captured.
  test.beforeEach(async ({ page }) => {
    // Awaited: the binding and init script must be registered before the first
    // navigation. Firing them with `void` was one of two candidate reasons the
    // recorder attached nothing on the run where #26 reproduced.
    await recordServerActionResponses(page);
  });

  // Flushed here, not from the callbacks that produce the records: attaching
  // from an exposeBinding callback or a page event does not reach the report,
  // which is why three earlier runs produced nothing at all. afterEach still
  // runs after a failure or timeout — the cases that matter for #26.
  test.afterEach(async () => {
    await flushFlightRecords();
  });

  test.beforeAll(async () => {
    db = new Client({ connectionString: DATABASE_URL });
    await db.connect();

    const gym = await db.query(
      `insert into gym (name, slug) values ($1, $2) returning id`,
      [gymName, `e2e-gym-${runId}`],
    );
    gymId = gym.rows[0].id;

    const member = await db.query(
      `insert into member (tenant_id, email, full_name, status)
       values ($1, $2, $3, 'active') returning id`,
      [gymId, memberEmail, "E2E Member"],
    );
    const memberId = member.rows[0].id;

    const program = await db.query(
      `insert into program (tenant_id, name, description)
       values ($1, $2, 'Full-body strength, 3x/week') returning id`,
      [gymId, programName],
    );
    const programId = program.rows[0].id;

    await db.query(
      `insert into exercise (tenant_id, program_id, position, name, sets, reps, rest, notes)
       values ($1, $2, 0, 'Back Squat', 5, '5', '180s', 'Bar over mid-foot')`,
      [gymId, programId],
    );

    await db.query(
      `insert into program_assignment (tenant_id, program_id, member_id, status)
       values ($1, $2, $3, 'active')`,
      [gymId, programId, memberId],
    );

    const tokenHash = createHash("sha256").update(rawInviteToken).digest("hex");
    await db.query(
      `insert into invite (tenant_id, member_id, email, token_hash, status, expires_at)
       values ($1, $2, $3, $4, 'pending', now() + interval '1 day')`,
      [gymId, memberId, memberEmail, tokenHash],
    );
  });

  test.afterAll(async () => {
    // Children (member, invite, program, exercise, assignment, logs) cascade.
    if (db) {
      if (gymId) await db.query(`delete from gym where id = $1`, [gymId]);
      await db.end();
    }
  });

  test("invite → accept → auto sign-in → portal, then logout → login → portal", async ({
    page,
  }) => {
    // 0. The portal is gated: unauthenticated visits bounce to the login page.
    // middleware.ts always attaches ?reason=session-expired on this redirect
    // (SIGN_IN_REASON_PARAM), even for a visitor who was never signed in, so
    // the form can explain itself rather than appearing to reject for nothing.
    await page.goto("/portal");
    await expect(page).toHaveURL(/\/portal\/login\?reason=session-expired$/);

    // 1. Open the invite link — the token resolves to the seeded member.
    await page.goto(`/invite/accept?token=${encodeURIComponent(rawInviteToken)}`);
    await expect(
      page.getByRole("heading", { name: "Set up your account" }),
    ).toBeVisible();
    await expect(page.getByText("Hi E2E Member")).toBeVisible();
    await captureResponsive(page, "04-invite-accept");

    // 2. Choose a password → the action provisions the auth user, consumes the
    //    invite, signs the member in, and redirects to the portal.
    await page.getByLabel("Choose a password").fill(memberPassword);
    await page.getByLabel("Confirm password").fill(memberPassword);
    await page.getByRole("button", { name: "Set up my account" }).click();

    await expect(page).toHaveURL(/\/portal$/, { timeout: 30_000 });

    // 3. The RLS-scoped portal shows the member's OWN assigned program — with
    //    its FULL exercise detail, not just a program title. The unit view test
    //    (test/member-portal-view.test.ts) pins the same four fields against
    //    `ProgramView` in isolation; this proves they survive the real
    //    session + RLS read path against a real database.
    await expect(page.getByText(programName)).toBeVisible();
    await expect(page.getByText("Back Squat")).toBeVisible();
    for (const label of ["Sets", "Reps", "Rest"]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    // "180s" rather than the sets/reps values, which are both "5" and would
    // match ambiguously; the notes are free text and unique on the page.
    await expect(page.getByText("180s")).toBeVisible();
    await expect(page.getByText("Bar over mid-foot")).toBeVisible();

    // The portal's primary form factor is a phone. At a 375px-wide viewport
    // (iPhone SE/mini class — the narrowest we support) the exercise detail
    // must still be readable and the page must not scroll sideways, which is
    // what a fixed-width or multi-column layout here would cause.
    await page.setViewportSize({ width: 375, height: 667 });
    await expect(page.getByText("Back Squat")).toBeVisible();
    await expect(page.getByText("Bar over mid-foot")).toBeVisible();
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflows, "portal scrolls horizontally at 375px").toBe(false);

    // Rendered evidence of the authenticated member portal — the surface the
    // public visual-capture spec can't reach without a session.
    await captureResponsive(page, "05-member-portal");

    // 4. The invite is single-use: revisiting the link shows the used notice.
    await page.goto(`/invite/accept?token=${encodeURIComponent(rawInviteToken)}`);
    await expect(page.getByText(/already been used/)).toBeVisible();

    // 5. Log out — back to the member login page.
    await page.goto("/portal");
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/portal\/login$/, { timeout: 30_000 });

    // 6. Sign in with the just-created credentials → portal renders again.
    await page.getByLabel("Email").fill(memberEmail);
    await page.getByLabel("Password").fill(memberPassword);
    // `exact`: the form's demo hint also renders a "Sign in as Member"
    // one-click button (app/DemoSignInHint.tsx). This flow must submit the
    // invited member's OWN credentials, not the seeded demo account's.
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expect(page).toHaveURL(/\/portal$/, { timeout: 30_000 });
    await expect(page.getByText(programName)).toBeVisible();
  });

  test("wrong password is rejected at the portal login", async ({ page }) => {
    await page.goto("/portal/login");
    await page.getByLabel("Email").fill(memberEmail);
    await page.getByLabel("Password").fill("definitely-wrong-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    // Note: Next.js's route announcer is also role="alert", so target the
    // visible error text rather than the bare role.
    await expect(page.getByText("Invalid email or password.")).toBeVisible();
    await expect(page).toHaveURL(/\/portal\/login$/);
  });
});
