import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards against the exact bug class docs/REVIEW.md flagged for the original
 * `0003_*` trio (and that recurred once more as `0019_member_photo.sql` /
 * `0019_waitlist_promotion.sql`, fixed by scripts/migrate.mjs's RENAMED map):
 * scripts/migrate.mjs applies migrations/*.sql sorted by filename, so two
 * files sharing a numeric prefix apply in whatever order string-sort of their
 * suffix happens to produce, not the order intent requires. Harmless only by
 * coincidence when the pair is independent; a silent footgun otherwise. This
 * is a pure filesystem check — no database required, so it always runs.
 */
const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

describe("migration filenames", () => {
  it("has no two files sharing the same leading numeric prefix", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    const byPrefix = new Map<string, string[]>();

    for (const file of files) {
      const match = file.match(/^(\d+)_/);
      expect(match, `${file} must start with a numeric prefix like 0001_`).not.toBeNull();
      const prefix = match![1];
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), file]);
    }

    const duplicates = [...byPrefix.entries()].filter(([, names]) => names.length > 1);
    expect(duplicates, `duplicate migration prefixes: ${JSON.stringify(duplicates)}`).toEqual([]);
  });
});
