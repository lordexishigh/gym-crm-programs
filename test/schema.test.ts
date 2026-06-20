import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import { closePool, withAdminContext } from "../lib/db";

/**
 * Schema smoke tests (subtask mvp-platform-foundation-003).
 * Verifies all seven core tables, tenant_id columns, RLS enablement, and the
 * assignment lookup indexes exist after a clean migration run. Requires a real
 * Postgres (CI provides one; skipped locally without DATABASE_URL).
 */
const hasDb = Boolean(process.env.DATABASE_URL);

const CORE_TABLES = [
  "gym",
  "users",
  "member",
  "invite",
  "program",
  "exercise",
  "program_assignment",
] as const;

describe.skipIf(!hasDb)("core schema", () => {
  beforeAll(async () => {
    await runMigrations();
  });
  afterAll(async () => {
    await closePool();
  });

  it("creates all seven core tables", async () => {
    const names = await withAdminContext(async (c) =>
      (
        await c.query(
          `select table_name from information_schema.tables
           where table_schema = 'public' and table_name = any($1)`,
          [CORE_TABLES as unknown as string[]],
        )
      ).rows.map((r) => r.table_name as string),
    );
    expect(names.sort()).toEqual([...CORE_TABLES].sort());
  });

  it("every tenanted table has a tenant_id column", async () => {
    // gym is the tenant itself (its id IS the tenant); the other six carry tenant_id.
    const tenanted = CORE_TABLES.filter((t) => t !== "gym");
    const withTenant = await withAdminContext(async (c) =>
      (
        await c.query(
          `select table_name from information_schema.columns
           where table_schema = 'public' and column_name = 'tenant_id'
             and table_name = any($1)`,
          [tenanted as unknown as string[]],
        )
      ).rows.map((r) => r.table_name as string),
    );
    expect(withTenant.sort()).toEqual([...tenanted].sort());
  });

  it("has RLS enabled and forced on every core table", async () => {
    const rows = await withAdminContext(async (c) =>
      (
        await c.query(
          `select relname, relrowsecurity, relforcerowsecurity
           from pg_class where relname = any($1)`,
          [CORE_TABLES as unknown as string[]],
        )
      ).rows,
    );
    expect(rows).toHaveLength(CORE_TABLES.length);
    expect(rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
  });

  it("has assignment lookup indexes on program_assignment", async () => {
    const indexes = await withAdminContext(async (c) =>
      (
        await c.query(
          `select indexname from pg_indexes
           where tablename = 'program_assignment'`,
        )
      ).rows.map((r) => r.indexname as string),
    );
    expect(indexes).toContain("idx_assignment_tenant_member");
    expect(indexes).toContain("idx_assignment_tenant_program");
  });
});
