// Boot-time built-in exercise catalog backfill (alpha-exercise-library-003).
//
// Seeds the built-in EXERCISE_CATALOG into EVERY gym's exercise_library so a
// brand-new (or freshly-migrated) gym is never empty "by construction" — the
// catalog is "already inside the CRM" without anyone running `npm run seed`.
//
// Run automatically on boot by instrumentation.ts (in a child process, AFTER
// migrations apply — the upsert needs the unique index from migration 0010),
// and runnable standalone:
//   node scripts/seed-catalog.mjs
//
// Uses a PRIVILEGED pg client (like scripts/migrate.mjs) rather than the app's
// RLS-bound `app_user` connection, because seeding legitimately crosses tenants
// — the same rationale as withAdminContext in lib/db.ts. Idempotent: re-running
// upserts in place (see seedExerciseCatalog).

import "dotenv/config";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { seedAllGyms } from "./seed.mjs";

/**
 * @param {string} [connectionString] defaults to MIGRATE_DATABASE_URL, then DATABASE_URL
 * @returns {Promise<number>} number of gyms seeded
 */
export async function runCatalogSeed(
  connectionString = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL,
) {
  if (!connectionString) {
    throw new Error(
      "No connection string: set MIGRATE_DATABASE_URL (preferred) or DATABASE_URL.",
    );
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await seedAllGyms(client);
  } finally {
    await client.end();
  }
}

// Run when invoked directly (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCatalogSeed().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
