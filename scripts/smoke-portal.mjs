/**
 * Prove the MEMBER PORTAL is live on a deployed URL (`npm run smoke:portal`).
 *
 * No shebang, for the same reason as scripts/deploy.mjs and scripts/postinstall.mjs:
 * test/smoke-portal.test.ts imports the pure helpers below, and Vite hoists its
 * CJS-interop declarations above a shebang, which is only valid at the very start
 * of a file. npm runs this as `node scripts/smoke-portal.mjs`, so it needs none.
 *
 * WHY THIS EXISTS
 *
 * An automated review has repeatedly reported the member self-service portal —
 * upcoming bookings, membership status, payment history — as "built but not live:
 * the code implements this but the running app doesn't serve it". Every time, the
 * components were present, wired into app/portal/page.tsx, and in fact SERVING
 * correctly in production.
 *
 * The finding kept recurring because nothing could cheaply disprove it. Everything
 * automated stops at the front door:
 *
 *   - `scripts/deploy.mjs` verifies `/`, `/login` and `/portal/login`. All three
 *     are STATIC, PRERENDERED, DATABASE-FREE pages. They render perfectly on a
 *     deployment whose portal is broken, whose database is unreachable, or whose
 *     demo data was never seeded.
 *   - `e2e/invite-flow.spec.ts` does cover the authenticated portal, but it needs
 *     a local throwaway Postgres and the GoTrue stub, so it skips outside CI —
 *     and CI cannot run at all (the Actions account is billing-blocked).
 *
 * So the only way to answer "does a member actually see their bookings?" was to
 * hand-drive a browser, which is not something a reviewer does and not something
 * that happens on a deploy. This script makes that check one command.
 *
 * It drives a REAL BROWSER against a REAL DEPLOYMENT: it signs in at
 * /portal/login with the demo member credentials and asserts the three portal
 * sections actually rendered. No database access, no Supabase keys, no test
 * fixtures — the credentials are the seed's public demo account, the same ones
 * the login page itself advertises.
 *
 * EXIT CODES are what let `deploy.mjs` treat this correctly (see `main`):
 *   0  the portal is live and every section rendered
 *   1  a DEFECT IN THE SHIPPED CODE — signed in, but the portal did not serve
 *   2  CANNOT RUN — Playwright/browser absent, or the demo member is not seeded
 *      on this deployment. Neither is fixable by the code being deployed, so
 *      these must not fail a deploy.
 */

import process from "node:process";

/**
 * The deployed URL to check. Same precedence as scripts/deploy.mjs, so one
 * `DEPLOY_VERIFY_URL` steers the deploy and its portal check together and they
 * can never end up asserting against two different environments.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {string[]} [argv]
 * @returns {string}
 */
export function resolveBaseUrl(env = process.env, argv = process.argv) {
  const flagIndex = argv.indexOf("--base");
  const fromFlag = flagIndex !== -1 ? argv[flagIndex + 1] : undefined;
  const raw =
    fromFlag ||
    env.SMOKE_BASE_URL ||
    env.DEPLOY_VERIFY_URL ||
    env.APP_BASE_URL ||
    "https://gym-crm-programs.vercel.app";
  return raw.replace(/\/$/, "");
}

/**
 * The demo member to sign in as.
 *
 * Deliberately reads the SEED_MEMBER_* variables — the very ones scripts/seed.mjs
 * reads — rather than inventing SMOKE_* names. An operator who seeded a
 * deployment with overridden credentials gets a working check for free, and there
 * is no third place for these values to drift out of sync. The defaults mirror
 * the seed's own defaults; test/smoke-portal.test.ts asserts they still match.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ email: string, password: string }}
 */
export function resolveMember(env = process.env) {
  return {
    email: env.SEED_MEMBER_EMAIL || "member@demo.local",
    password: env.SEED_MEMBER_PASSWORD || "DemoMember!2026",
  };
}

/**
 * The portal sections this script exists to prove are being served, each keyed by
 * the `<h2>` app/portal/page.tsx renders for it.
 *
 * These are exactly the three features the review reports as missing, so the
 * assertion and the claim are the same thing. `PaymentHistory` renders its
 * heading above an empty state when a member has no payments, so a rendered
 * heading — not a populated list — is the correct thing to require: an empty
 * payment history is a real, correct answer for a member who has not paid yet.
 */
export const REQUIRED_SECTIONS = [
  { heading: "Classes", feature: "upcoming bookings / bookable class schedule" },
  { heading: "Membership", feature: "membership status" },
  { heading: "Payment history", feature: "payment history" },
];

/**
 * Turn the headings actually found on the live page into a pass/fail verdict.
 *
 * Pure, so "what counts as the portal being served" is unit-tested rather than
 * only exercised by a real browser against a real deployment.
 *
 * @param {string[]} headings text of every heading rendered on /portal
 */
export function portalVerdict(headings) {
  const seen = headings.map((h) => h.trim());
  const missing = REQUIRED_SECTIONS.filter(
    (section) => !seen.some((h) => h === section.heading),
  ).map((section) => `${section.feature} (no "${section.heading}" heading rendered)`);
  return { ok: missing.length === 0, missing };
}

/**
 * Load Playwright out of the repo, or report that it is unavailable.
 *
 * Imported dynamically rather than at module scope so the unit test above can
 * import this file's pure helpers on a machine with no browsers installed.
 */
async function loadChromium() {
  try {
    const pw = await import("playwright");
    // playwright's entrypoint is CJS; the named export may land on `default`.
    return pw.chromium ?? pw.default?.chromium ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const base = resolveBaseUrl();
  const { email, password } = resolveMember();

  const chromium = await loadChromium();
  if (!chromium) {
    console.warn(
      "[smoke] CANNOT RUN: the `playwright` package is not installed. " +
        "Install dev dependencies (`npm install`) and browsers " +
        "(`npx playwright install chromium`) to verify the member portal.",
    );
    process.exit(2);
  }

  console.log(`[smoke] Verifying the member portal on ${base} as ${email}.`);

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    console.warn(
      "[smoke] CANNOT RUN: Chromium failed to launch — run " +
        `\`npx playwright install chromium\`.\n[smoke]   ${err.message}`,
    );
    process.exit(2);
  }

  try {
    // A phone viewport: the portal is a mobile-first surface and this is the form
    // factor a member actually opens it on.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();

    const login = await page.goto(`${base}/portal/login`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    if (login?.status() !== 200) {
      console.error(
        `[smoke] FAILED: ${base}/portal/login returned HTTP ${login?.status() ?? "no response"}.`,
      );
      process.exit(1);
    }

    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');

    // Signing in must land on /portal. Anything else — a visible error, a stalled
    // action — is diagnosed below rather than reported as a bare timeout.
    let signedIn = true;
    try {
      await page.waitForURL((url) => new URL(url).pathname === "/portal", {
        timeout: 45_000,
      });
    } catch {
      signedIn = false;
    }

    if (!signedIn) {
      const alerts = (await page.locator('[role="alert"]').allTextContents())
        .map((t) => t.trim())
        .filter(Boolean);
      const rejected = alerts.some((t) => /invalid email or password/i.test(t));

      if (rejected) {
        // Environment, not code: this deployment has no such member. `npm run
        // seed` was never run here, or SEED_MEMBER_* were overridden. A deploy
        // must not fail on it — the code being shipped is not at fault.
        console.warn(
          `[smoke] CANNOT RUN: ${base} rejected the demo member ${email}. ` +
            "The demo account is not seeded on this deployment (run `npm run seed`, " +
            "or set SEED_MEMBER_EMAIL/SEED_MEMBER_PASSWORD to a member that exists). " +
            "The portal itself was not exercised.",
        );
        process.exit(2);
      }

      console.error(
        `[smoke] FAILED: signing in at ${base}/portal/login did not reach /portal.\n` +
          `[smoke]   still at: ${page.url()}\n` +
          `[smoke]   page said: ${alerts.length ? alerts.join(" | ") : "(no error shown)"}\n` +
          "[smoke] Members cannot get into the portal at all on this deployment.",
      );
      process.exit(1);
    }

    // `force-dynamic` + parallel DB reads: let the server-rendered content settle.
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

    const headings = await page.locator("h1, h2").allTextContents();
    const { ok, missing } = portalVerdict(headings);

    for (const section of REQUIRED_SECTIONS) {
      const present = headings.map((h) => h.trim()).includes(section.heading);
      console.log(`[smoke]   ${present ? "OK  " : "FAIL"} ${section.feature}`);
    }

    if (!ok) {
      console.error(
        "[smoke] FAILED: a member signed in successfully but the portal did not " +
          "serve:\n" +
          missing.map((m) => `[smoke]   - ${m}`).join("\n") +
          `\n[smoke]   headings rendered: ${JSON.stringify(headings)}\n` +
          "[smoke] This is the 'built but not live' state: the components exist in " +
          "the source but the running app is not serving them.",
      );
      process.exit(1);
    }

    console.log(
      `[smoke] Done. ${base}/portal serves the member self-service portal — ` +
        "bookings, membership status and payment history all render for a signed-in member.",
    );
  } finally {
    await browser.close();
  }
}

// Only run when invoked directly, so the unit tests can import the pure helpers
// above without launching a browser.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith("smoke-portal.mjs");
if (invokedDirectly) {
  main().catch((err) => {
    console.error("[smoke] unexpected failure:", err);
    process.exit(1);
  });
}
