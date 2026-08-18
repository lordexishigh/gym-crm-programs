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
 * Hosts this runner will apply DDL to without being asked twice.
 *
 * `test/setup/db-safety.ts` guards the vitest suites against a specific dotenv trap, and
 * says so at length: importing this file loads `.env`, and locally `.env` carries the
 * PRODUCTION connection string. That guard protects the TESTS. It does not protect
 * `npm run migrate`, which is the command CI runs, therefore the command anyone
 * reproducing CI runs — and unlike the tests, this one executes DDL.
 *
 * It is also worse than the tests' version of the trap, for a reason that is not obvious:
 * this runner prefers MIGRATE_DATABASE_URL, and BOTH `.env` and `.env.local` set it to the
 * production host. So a developer who knows about the trap, and carefully exports
 * `DATABASE_URL=postgres://...@localhost/...`, is STILL pointed at production, because
 * dotenv fills in the variable they did not think to override.
 *
 * Observed 2026-08-19: a local run reported "nothing to apply (database already up to
 * date)" against a database created empty seconds earlier. It had connected to production.
 * Nothing was mutated — production was current, so no DDL ran — but a pending migration
 * would have been applied there by a command whose whole purpose was to set up a local
 * database.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Host, port and database name of a connection string, or null if it will not parse. */
function describeTarget(connectionString) {
  try {
    const u = new URL(connectionString);
    return {
      host: u.hostname.replace(/^\[|\]$/g, ""),
      port: u.port || "5432",
      database: u.pathname.slice(1) || "(server default)",
    };
  } catch {
    return null;
  }
}

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
 *
 * 0020_waitlist_promotion.sql was renumbered from a duplicate `0019_` prefix
 * shared with 0019_member_photo.sql (independent tables, so the collision was
 * harmless in practice, but ambiguous by construction — see
 * test/migration-filenames.test.ts, which now fails the build on any future
 * duplicate). `0019_member_photo.sql` KEEPS its number; only the other file
 * of the colliding pair moves. It then collided AGAIN, this time with
 * 0020_task_queue.sql added independently on master while this rename sat in
 * an unmerged branch — moved once more, to 0022_waitlist_promotion.sql
 * (0021 already taken by 0021_suggestions.sql). Neither this migration nor
 * its 0020 name was ever deployed anywhere (branch never merged), but the
 * alias still maps back to its original 0019 name for consistency with the
 * rest of this table and in case any throwaway environment recorded it there.
 */
const RENAMED = {
  "0011_assignment_lifecycle.sql": "0003_assignment_lifecycle.sql",
  "0012_member_extended_fields.sql": "0003_member_extended_fields.sql",
  "0022_waitlist_promotion.sql": "0019_waitlist_promotion.sql",
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

  // Say where, before doing anything. The old output named the migrations and never the
  // target, so "nothing to apply" against the wrong database was indistinguishable from
  // "nothing to apply" against the right one.
  const target = describeTarget(connectionString);
  console.log(
    target
      ? `Migrating ${target.database} at ${target.host}:${target.port}`
      : "Migrating an unparseable connection string",
  );

  // Fail closed: an unparseable target counts as remote, because it cannot be shown to be
  // local. `ALLOW_REMOTE_MIGRATE=1` is the deliberate override, and the deploy path sets it.
  const isLocal = target !== null && LOCAL_HOSTS.has(target.host);
  if (!isLocal && process.env.ALLOW_REMOTE_MIGRATE !== "1") {
    throw new Error(
      [
        `Refusing to migrate a non-local database (${target ? target.host : "unparseable target"}).`,
        "This runs DDL. Both .env and .env.local set MIGRATE_DATABASE_URL to the production",
        "host, and it takes precedence over DATABASE_URL, so exporting DATABASE_URL alone is",
        "not enough to point this at a local database.",
        "",
        "  Local work:  export DATABASE_URL and MIGRATE_DATABASE_URL to a throwaway Postgres",
        "  Deliberate:  ALLOW_REMOTE_MIGRATE=1 (set by the deploy workflow, scripts/deploy.mjs",
        "               and the boot-time migration in instrumentation.ts)",
      ].join("\n"),
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
