// Idempotent SQL migration runner.
//
// Applies every migrations/*.sql file (sorted by filename) that has not yet
// been recorded in the schema_migrations table, each in its own transaction.
// Safe to run against a FRESH database (creates everything) and an EXISTING one
// (skips already-applied files) — so it can run automatically on every deploy.
//
// Usage:
//   node scripts/migrate.mjs            # uses DATABASE_URL
//   import { runMigrations } from "./scripts/migrate.mjs"  # programmatic (tests)

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import "dotenv/config";
import pg from "pg";

const { Client } = pg;
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * @param {string} [connectionString] defaults to process.env.DATABASE_URL
 * @returns {Promise<string[]>} filenames applied during this run
 */
export async function runMigrations(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (and no connection string passed).");
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = new Client({ connectionString });
  await client.connect();
  const applied = [];

  try {
    await client.query(`
      create table if not exists schema_migrations (
        id          text primary key,
        applied_at  timestamptz not null default now()
      )
    `);

    const { rows } = await client.query("select id from schema_migrations");
    const done = new Set(rows.map((r) => r.id));

    for (const file of files) {
      if (done.has(file)) {
        console.log(`= skip   ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into schema_migrations (id) values ($1)", [file]);
        await client.query("commit");
        applied.push(file);
        console.log(`+ apply  ${file}`);
      } catch (err) {
        await client.query("rollback");
        console.error(`! failed ${file}: ${err.message}`);
        throw err;
      }
    }
  } finally {
    await client.end();
  }

  console.log(
    applied.length
      ? `Migrations complete: ${applied.length} applied.`
      : "Migrations complete: nothing to apply (database already up to date).",
  );
  return applied;
}

// Run when invoked directly (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runMigrations().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
