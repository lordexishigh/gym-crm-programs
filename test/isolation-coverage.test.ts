import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import { closePool, withAdminContext } from "../lib/db";

/**
 * RLS coverage matrix (beta-isolation-audit-001).
 *
 * The per-feature isolation suites prove that the tables they KNOW about are
 * locked down. This suite is the catch-all guard against the opposite failure:
 * a NEW tenanted table shipping without RLS. Migration 0002 was written before
 * the tables in 0003/0004/0006 existed, so isolation for those lives in their
 * own migrations — and nothing structurally forces a future table to follow.
 *
 * Rather than hard-code a table list (which would itself drift), this test
 * DISCOVERS every tenanted table from the live catalog — any table carrying a
 * `tenant_id` column, plus `gym` (whose own id IS the tenant) — and asserts for
 * each that (a) RLS is ENABLED and FORCED and (b) at least one policy exists.
 * A new tenanted table with no RLS therefore fails CI by construction.
 *
 * Catalog reads run on the privileged connection (reading pg_class/pg_policies
 * is not an RLS-gated data read). Requires a real PostgreSQL 16 instance (CI
 * provides DATABASE_URL); skipped locally with a notice when absent.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn(
    "[isolation-coverage.test] DATABASE_URL not set — skipping (runs in CI).",
  );
}

// The tables this audit KNOWS must be tenant-isolated. Discovery must find at
// least these; the discovery query also catches any future table we forget to
// list here. (`schema_migrations`, the runner's bookkeeping table, has no
// tenant_id and is correctly excluded.)
const EXPECTED_TENANTED_TABLES = [
  "gym",
  "users",
  "member",
  "invite",
  "program",
  "exercise",
  "program_assignment",
  "exercise_library",
  "program_template",
  "template_exercise",
  "member_status_event",
  "gdpr_audit_event",
  // Member profile photographs — the most identifying data the CRM stores, so
  // its isolation is pinned explicitly rather than left to discovery alone.
  "member_photo",
] as const;

type CatalogRow = {
  relname: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
};

let tenantedTables: string[] = [];
let catalog: CatalogRow[] = [];
let policyCounts = new Map<string, number>();

describe.skipIf(!hasDb)("RLS coverage matrix (every tenanted table)", () => {
  beforeAll(async () => {
    await runMigrations();

    await withAdminContext(async (c) => {
      // Discover every base table that is tenant-scoped: it carries a tenant_id
      // column, or it is `gym` (the tenant root). Joined to pg_class so we get
      // the RLS flags in the same pass.
      const rows = (
        await c.query<CatalogRow>(
          `select cls.relname,
                  cls.relrowsecurity,
                  cls.relforcerowsecurity
             from pg_class cls
             join pg_namespace ns on ns.oid = cls.relnamespace
            where ns.nspname = 'public'
              and cls.relkind = 'r'
              and (
                cls.relname = 'gym'
                or exists (
                  select 1
                    from information_schema.columns col
                   where col.table_schema = 'public'
                     and col.table_name = cls.relname
                     and col.column_name = 'tenant_id'
                )
              )
            order by cls.relname`,
        )
      ).rows;
      catalog = rows;
      tenantedTables = rows.map((r) => r.relname);

      const pol = (
        await c.query<{ tablename: string; n: string }>(
          `select tablename, count(*)::text as n
             from pg_policies
            where schemaname = 'public'
            group by tablename`,
        )
      ).rows;
      policyCounts = new Map(pol.map((r) => [r.tablename, Number(r.n)]));
    });
  });

  afterAll(async () => {
    await closePool();
  });

  it("discovers (at least) every known tenanted table", () => {
    // Every table we expect must be present in the discovered set. (If a future
    // migration adds another tenanted table, discovery picks it up too and the
    // per-table assertions below still apply to it.)
    for (const t of EXPECTED_TENANTED_TABLES) {
      expect(tenantedTables, `missing tenanted table: ${t}`).toContain(t);
    }
  });

  it("has RLS ENABLED and FORCED on every tenanted table", () => {
    expect(catalog.length).toBeGreaterThanOrEqual(
      EXPECTED_TENANTED_TABLES.length,
    );
    for (const row of catalog) {
      expect(
        row.relrowsecurity,
        `${row.relname}: row level security is not ENABLED`,
      ).toBe(true);
      expect(
        row.relforcerowsecurity,
        `${row.relname}: row level security is not FORCED`,
      ).toBe(true);
    }
  });

  it("has at least one policy on every tenanted table", () => {
    for (const t of tenantedTables) {
      expect(policyCounts.get(t) ?? 0, `${t}: has no RLS policy`).toBeGreaterThan(
        0,
      );
    }
  });
});
