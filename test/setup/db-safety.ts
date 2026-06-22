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
