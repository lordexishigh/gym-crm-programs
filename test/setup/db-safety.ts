// Test-suite DB safety guard (beta-isolation-audit).
//
// The RLS isolation suites SEED and MUTATE real rows (two conflicting tenants,
// members, programs, forged-write attempts). They must only ever run against a
// throwaway database — never a shared/staging/production one.
//
// The trap: `scripts/migrate.mjs` does `import "dotenv/config"`, so importing it
// (every DB test does) loads `.env`. Locally `.env` carries the PRODUCTION
// Supabase connection string, so a developer running `npm test` would silently
// seed production. CI is unaffected because it sets `DATABASE_URL` to a local
// throwaway Postgres in the workflow env, which already-set value dotenv leaves
// untouched.
//
// This guard runs as a vitest `setupFile` (in every worker, before any test
// module is imported). It resolves `.env` the same way the runner does, then —
// unless the resolved `DATABASE_URL` points at a local host or the operator has
// explicitly opted in — blanks `DATABASE_URL`/`MIGRATE_DATABASE_URL` so the
// `hasDb` guards in the DB suites see "no database" and SKIP, rather than
// running against a remote target. Setting the vars to "" (not deleting them)
// means the later `import "dotenv/config"` in migrate.mjs will NOT repopulate
// them (dotenv never overrides a key already present in `process.env`).
import "dotenv/config";

/** Hosts considered safe to seed/mutate from the test suite. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLocalDatabase(url: string): boolean {
  try {
    // node-postgres accepts both `postgres://` and `postgresql://`.
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return LOCAL_HOSTS.has(host);
  } catch {
    // Unparseable (e.g. a bare socket path) — treat as NOT local, i.e. unsafe.
    return false;
  }
}

const url = process.env.DATABASE_URL ?? "";
const optedIn = process.env.ALLOW_NONLOCAL_TEST_DB === "1";

if (url && !isLocalDatabase(url) && !optedIn) {
  // eslint-disable-next-line no-console
  console.warn(
    `[db-safety] DATABASE_URL points at a non-local host — refusing to run the ` +
      `seeding RLS suites against it. DB-backed tests will SKIP. Point ` +
      `DATABASE_URL at a local/throwaway Postgres (CI does this), or set ` +
      `ALLOW_NONLOCAL_TEST_DB=1 to override deliberately.`,
  );
  process.env.DATABASE_URL = "";
  process.env.MIGRATE_DATABASE_URL = "";
}

// In the repo's GitHub Actions CI the full DB-backed suite is MANDATORY, not
// optional: the workflow provisions a throwaway postgres:16 service container
// and exports a localhost DATABASE_URL (see .github/workflows/ci.yml).
// Skipping is a local-development convenience only — if DATABASE_URL is
// absent there (never set, or blanked just above because it pointed at a
// non-local host), every RLS/isolation suite would silently skip and CI would
// green-light a build whose core security guarantee was never verified. Fail
// the run instead.
//
// Keyed on GITHUB_ACTIONS, not the generic CI flag: many runners (editor test
// harnesses, sandboxes) export CI=1 without provisioning a database, and for
// those the correct behavior is the same as local dev — skip the DB suites —
// not a hard failure of every test file. Only our own workflow guarantees a
// throwaway Postgres, so only there is a missing DATABASE_URL a config bug.
if (process.env.GITHUB_ACTIONS && !process.env.DATABASE_URL) {
  throw new Error(
    "[db-safety] CI run has no usable local DATABASE_URL, so the RLS/DB test " +
      "suites would be silently skipped. Provision a throwaway Postgres in " +
      "the workflow (postgres:16 service container) and export a localhost " +
      "DATABASE_URL — see .github/workflows/ci.yml.",
  );
}
