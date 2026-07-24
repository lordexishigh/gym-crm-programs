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
 * Migrations renamed after they had already been applied somewhere, mapping the
 * CURRENT filename -> the OLD filename it used to carry.
 *
 * The runner records each *applied filename* in `schema_migrations`. Renaming a
 * file would otherwise make an already-migrated database (e.g. production) see
 * the new name as "never applied" and RE-RUN its DDL. Before applying anything,
 * we backfill: for any DB that recorded the old id, we record the new id too
 * (without re-running the SQL). On a fresh DB neither id is present, so the file
 * simply applies once under its new name. Keeps the rename safe and idempotent.
 *
 * 0011/0012 were renumbered from a duplicate `0003_` prefix so ordering is
 * unambiguous; `0003_library_and_templates.sql` KEEPS its number because
 * 0009/0010 extend the `exercise_library` table it creates and must run after it.
 */
const RENAMED = {
  "0011_assignment_lifecycle.sql": "0003_assignment_lifecycle.sql",
  "0012_member_extended_fields.sql": "0003_member_extended_fields.sql",
};

/**
 * @param {string} [connectionString] defaults to MIGRATE_DATABASE_URL, then DATABASE_URL
 * @returns {Promise<string[]>} filenames applied during this run
 *
 * NOTE: migrations run DDL (CREATE/ALTER/GRANT ROLE). Supabase's *transaction*
 * pooler (port 6543) rejects some of these with a FATAL XX000 and drops the
 * connection. Run migrations against the **Session pooler (5432)** or the
 * **Direct connection** instead — set MIGRATE_DATABASE_URL to that connection
 * string and leave DATABASE_URL pointing at the (transaction) pooler the app uses.
 */
export async function runMigrations(
  connectionString = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL,
) {
  if (!connectionString) {
    throw new Error(
      "No connection string: set MIGRATE_DATABASE_URL (preferred for DDL) or DATABASE_URL.",
    );
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

    // Backfill renamed migrations: if a DB already recorded the OLD filename,
    // record the NEW one too so the renamed file is not re-run. Idempotent.
    for (const [newId, oldId] of Object.entries(RENAMED)) {
      if (done.has(oldId) && !done.has(newId)) {
        await client.query(
          "insert into schema_migrations (id) values ($1) on conflict (id) do nothing",
          [newId],
        );
        done.add(newId);
        console.log(`~ alias  ${newId} (already applied as ${oldId})`);
      }
    }

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
