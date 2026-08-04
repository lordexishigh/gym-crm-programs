import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for verifying a deployment that is ALREADY RUNNING
 * (`npm run verify:live`), as opposed to `playwright.config.ts`, which builds and
 * boots the app locally against a GoTrue stand-in.
 *
 * The distinction is the whole reason this file exists. The local suite proves
 * the CODE is correct; only this one can answer the review finding that keeps
 * recurring — "the code implements staff authentication but the running app
 * doesn't serve it". So:
 *
 *   - NO `webServer`. Starting a server would test this checkout instead of the
 *     deployment, which is precisely the mistake being guarded against.
 *   - NO database or auth stub. It drives the public sign-in path exactly as a
 *     visitor does, over HTTPS, with no privileged access to the environment.
 *
 * Point it anywhere with VERIFY_BASE_URL (a preview URL, a local `npm start`, a
 * staging alias); it defaults to production, which is the URL the finding is
 * about. `scripts/deploy.mjs` runs this after every deploy.
 */

const BASE_URL = (
  process.env.VERIFY_BASE_URL ||
  process.env.APP_BASE_URL ||
  "https://gym-crm-programs.vercel.app"
).replace(/\/$/, "");

export default defineConfig({
  testDir: "./e2e/live",
  // Generous: a serverless deployment may be cold, and the first request can pay
  // a container start plus the boot-time migration runner (instrumentation.ts).
  timeout: 150_000,
  // Sign-in is throttled per account (lib/auth/login-throttle.ts), so these must
  // never run concurrently against the same deployment.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  /**
   * One retry, unlike the local suite's zero.
   *
   * There the fixtures are single-use and a retry would start from mutated state.
   * Here the journey is read-only apart from its own session, and a successful
   * sign-in clears the throttle buckets it used, so a retry is both safe and
   * worth having: it separates a genuinely broken sign-in from one slow cold
   * start, which is the difference between failing a deploy and not.
   */
  retries: 1,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // Never let a CDN or the browser cache answer for the deployment.
    extraHTTPHeaders: { "cache-control": "no-cache" },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
