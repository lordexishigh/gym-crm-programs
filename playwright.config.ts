import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright end-to-end configuration (journey-level tests in ./e2e).
 *
 * Two servers are started for a run:
 *   1. The GoTrue auth stand-in (e2e/auth-stub.mjs) on 127.0.0.1:54321 — real
 *      ES256 JWTs + JWKS, so the app's untouched verification path is used.
 *   2. The BUILT Next.js app (`npm run start`) — journeys run against the same
 *      assembled product the smoke test probes, not the dev server.
 *
 * Prerequisites: `npm run build` with NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
 * (Next inlines NEXT_PUBLIC_* at build time) and a LOCAL throwaway Postgres in
 * DATABASE_URL with migrations applied. CI does all of this; see
 * .github/workflows/ci.yml. Locally the suite SKIPS unless DATABASE_URL points
 * at a local host (same safety rule as test/setup/db-safety.ts).
 */

const APP_PORT = 3000;
const AUTH_STUB_URL = "http://127.0.0.1:54321";

export default defineConfig({
  testDir: "./e2e",
  /**
   * `e2e/live/` verifies an ALREADY-DEPLOYED app and must not run here: it signs
   * in with the `npm run seed` demo accounts, which do not exist in the auth
   * stand-in this config boots, so it would fail for a reason that says nothing
   * about the code. It has its own config — see playwright.live.config.ts.
   */
  testIgnore: "live/**",
  timeout: 90_000,
  // The journey mutates shared DB fixtures; keep it strictly serial.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // The journey consumes single-use fixtures (the invite); a retry would start
  // from mutated state and fail misleadingly — fail fast and read the trace.
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node e2e/auth-stub.mjs",
      url: `${AUTH_STUB_URL}/auth/v1/.well-known/jwks.json`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      // See the app server below — same reason, and the stub is a suspect too:
      // a journey step that hangs on a token exchange looks identical from the
      // browser side to one hanging in the app.
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npm run start",
      url: `http://localhost:${APP_PORT}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      // `webServer.stdout` defaults to "ignore", so everything these servers
      // print during the run is DISCARDED — including on the run that fails.
      // The staff journey stalls for >30s at a rotating point (issue #26), and
      // because two of the three observed stalls were plain navigations rather
      // than Server Actions, the question is what the server itself was doing,
      // which is exactly the output that was being thrown away. The smoke-test
      // step redirects its own server to /tmp/next-start.log; Playwright's
      // webServer had no equivalent.
      stdout: "pipe",
      stderr: "pipe",
      env: {
        // Migrations/seed are applied out-of-band (CI does it before building).
        AUTO_MIGRATE: "0",
        AUTO_SEED: "0",
        NEXT_PUBLIC_SUPABASE_URL: AUTH_STUB_URL,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_e2e_stub",
        SUPABASE_SECRET_KEY: "sb_secret_e2e_stub",
      },
    },
  ],
});
