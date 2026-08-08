import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateClassInput } from "../lib/classes";

const CLASSES_SRC = readFileSync(path.join(process.cwd(), "lib", "classes.ts"), "utf8");
const MIGRATION_WAITLIST_PROMOTION = readFileSync(
  path.join(process.cwd(), "migrations", "0022_waitlist_promotion.sql"),
  "utf8",
);

describe("validateClassInput", () => {
  const base = {
    name: "Morning CrossFit",
    startsAt: "2026-01-01T09:00",
    durationMinutes: "60",
    capacity: "12",
  };

  it("accepts a full valid submission", () => {
    const r = validateClassInput(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("Morning CrossFit");
      expect(r.value.durationMinutes).toBe(60);
      expect(r.value.capacity).toBe(12);
      expect(r.value.instructorName).toBe(null);
    }
  });

  it("rejects a missing name", () => {
    expect(validateClassInput({ ...base, name: "  " }).ok).toBe(false);
  });

  it("trims a provided instructor name and treats blank as null", () => {
    const r = validateClassInput({ ...base, instructorName: "  Coach Maria  " });
    expect(r.ok && r.value.instructorName).toBe("Coach Maria");
    const blank = validateClassInput({ ...base, instructorName: "   " });
    expect(blank.ok && blank.value.instructorName).toBe(null);
  });

  it("rejects an invalid or missing start date/time", () => {
    expect(validateClassInput({ ...base, startsAt: "" }).ok).toBe(false);
    expect(validateClassInput({ ...base, startsAt: "not-a-date" }).ok).toBe(false);
  });

  it("rejects a non-positive or excessive duration", () => {
    expect(validateClassInput({ ...base, durationMinutes: "0" }).ok).toBe(false);
    expect(validateClassInput({ ...base, durationMinutes: "-10" }).ok).toBe(false);
    expect(validateClassInput({ ...base, durationMinutes: "601" }).ok).toBe(false);
    expect(validateClassInput({ ...base, durationMinutes: "abc" }).ok).toBe(false);
  });

  it("rejects a non-positive or excessive capacity", () => {
    expect(validateClassInput({ ...base, capacity: "0" }).ok).toBe(false);
    expect(validateClassInput({ ...base, capacity: "1001" }).ok).toBe(false);
    expect(validateClassInput({ ...base, capacity: "abc" }).ok).toBe(false);
  });
});

/**
 * `promoteFromWaitlist` is a single SQL statement whose correctness lives
 * entirely in that statement, and there is no local Postgres to exercise it
 * against. These assertions pin the four properties that are silently
 * catastrophic to lose in a later edit — each one fails open (promotes the
 * wrong people, or everyone) rather than erroring, so nothing else would catch
 * a regression.
 */
describe("promoteFromWaitlist SQL contract", () => {
  const sql = CLASSES_SRC.slice(
    CLASSES_SRC.indexOf("export async function promoteFromWaitlist"),
    CLASSES_SRC.indexOf("export async function markPromotionNotified"),
  );

  it("is extracted from the source (guards the assertions below)", () => {
    expect(sql).toContain("with target as");
    expect(sql).toContain("update class_bookings cb");
  });

  // A bare `limit (select …)` that evaluates to NULL means "no limit" in
  // Postgres — for a missing or already-started class that would promote the
  // ENTIRE waitlist into a class with no free spots.
  it("coalesces the LIMIT so a NULL free-slot count never means 'unlimited'", () => {
    expect(sql).toMatch(/limit coalesce\(\(select greatest\(slots, 0\) from free\), 0\)/);
  });

  // Promotion runs in admin context, which bypasses RLS. Tenant scoping must
  // therefore be explicit in the statement itself.
  it("scopes every table reference to the tenant explicitly", () => {
    expect(sql).toContain("withAdminContext");
    // classes lookup, the booked-count join, the waitlist selection and the
    // member join must each carry the tenant predicate.
    expect(sql.match(/tenant_id = \$2/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("only promotes into classes that have not already started", () => {
    expect(sql).toContain("cl.starts_at >= now()");
  });

  it("takes the longest-waiting member first, and skips rows locked by a concurrent cancel", () => {
    expect(sql).toContain("order by cb.booked_at asc");
    expect(sql).toContain("for update skip locked");
  });

  it("records the promotion so it can be notified exactly once", () => {
    expect(sql).toContain("promoted_at = now()");
  });
});

describe("cancelBooking", () => {
  // Callers must email whoever moved up; a `promotedMemberId`-style scalar
  // would silently drop the extra members a multi-spot promotion can free.
  it("returns the full promoted rows rather than a single id", () => {
    expect(CLASSES_SRC).toContain("promoted: PromotedBooking[]");
    expect(CLASSES_SRC).not.toContain("promotedMemberId");
  });
});

describe("migration 0022_waitlist_promotion", () => {
  it("adds the promotion columns idempotently", () => {
    expect(MIGRATION_WAITLIST_PROMOTION).toContain(
      "add column if not exists promoted_at timestamptz",
    );
    expect(MIGRATION_WAITLIST_PROMOTION).toContain(
      "add column if not exists promotion_notified_at timestamptz",
    );
  });

  it("adds no default, so existing bookings read as never promoted", () => {
    expect(MIGRATION_WAITLIST_PROMOTION).not.toMatch(/promoted_at timestamptz[^;]*default/i);
  });
});
