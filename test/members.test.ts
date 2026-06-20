import { describe, expect, it } from "vitest";
import {
  memberRosterWhere,
  parseRosterFilters,
  rosterPageCount,
  validateMemberInput,
} from "../lib/members";

/**
 * Unit tests for member input validation (mvp-member-management-001) and the
 * roster search/filter helpers (alpha-member-records-002). Pure functions — no
 * DB. Assert required-field enforcement, extended-field handling, normalisation,
 * and the SQL clause/param shaping for search + filtering.
 */
describe("validateMemberInput", () => {
  it("accepts a full name only (email/phone/notes optional)", () => {
    const r = validateMemberInput({ fullName: "Jane Athlete" });
    expect(r).toEqual({
      ok: true,
      value: {
        fullName: "Jane Athlete",
        email: null,
        phone: null,
        status: "active",
        notes: null,
      },
    });
  });

  it("rejects a missing/blank full name", () => {
    expect(validateMemberInput({ fullName: "   " }).ok).toBe(false);
    expect(validateMemberInput({}).ok).toBe(false);
  });

  it("trims the name and lowercases the email", () => {
    const r = validateMemberInput({
      fullName: "  Bob  ",
      email: "  BOB@Example.COM ",
    });
    expect(r.ok && r.value).toEqual({
      fullName: "Bob",
      email: "bob@example.com",
      phone: null,
      status: "active",
      notes: null,
    });
  });

  it("rejects a malformed email", () => {
    const r = validateMemberInput({ fullName: "X", email: "not-an-email" });
    expect(r.ok).toBe(false);
  });

  it("treats a blank email as null (not invalid)", () => {
    const r = validateMemberInput({ fullName: "X", email: "   " });
    expect(r.ok && r.value.email).toBe(null);
  });

  it("accepts and trims a valid phone number", () => {
    const r = validateMemberInput({ fullName: "X", phone: " +357 99 123456 " });
    expect(r.ok && r.value.phone).toBe("+357 99 123456");
  });

  it("treats a blank phone as null and rejects letters in a phone", () => {
    const blank = validateMemberInput({ fullName: "X", phone: "  " });
    expect(blank.ok && blank.value.phone).toBe(null);
    expect(validateMemberInput({ fullName: "X", phone: "call me" }).ok).toBe(false);
  });

  it("trims notes and treats blank notes as null", () => {
    const r = validateMemberInput({ fullName: "X", notes: "  knee injury  " });
    expect(r.ok && r.value.notes).toBe("knee injury");
    const blank = validateMemberInput({ fullName: "X", notes: "   " });
    expect(blank.ok && blank.value.notes).toBe(null);
  });

  it("rejects notes over the length cap", () => {
    const r = validateMemberInput({ fullName: "X", notes: "a".repeat(2001) });
    expect(r.ok).toBe(false);
  });

  it("rejects an out-of-range status", () => {
    expect(validateMemberInput({ fullName: "X", status: "deleted" }).ok).toBe(false);
  });

  it("accepts an explicit inactive status", () => {
    const r = validateMemberInput({ fullName: "X", status: "inactive" });
    expect(r.ok && r.value.status).toBe("inactive");
  });
});

describe("parseRosterFilters", () => {
  it("defaults to empty search, all statuses, page 1", () => {
    expect(parseRosterFilters({})).toEqual({ q: "", status: "all", page: 1 });
  });

  it("trims the search term", () => {
    expect(parseRosterFilters({ q: "  Jane  " }).q).toBe("Jane");
  });

  it("accepts valid status filters and rejects others", () => {
    expect(parseRosterFilters({ status: "active" }).status).toBe("active");
    expect(parseRosterFilters({ status: "inactive" }).status).toBe("inactive");
    expect(parseRosterFilters({ status: "bogus" }).status).toBe("all");
  });

  it("parses a positive page and falls back to 1 for junk", () => {
    expect(parseRosterFilters({ page: "3" }).page).toBe(3);
    expect(parseRosterFilters({ page: "0" }).page).toBe(1);
    expect(parseRosterFilters({ page: "-2" }).page).toBe(1);
    expect(parseRosterFilters({ page: "abc" }).page).toBe(1);
  });
});

describe("memberRosterWhere", () => {
  it("returns no clause when unfiltered", () => {
    const { clause, params } = memberRosterWhere({ q: "", status: "all", page: 1 });
    expect(clause).toBe("");
    expect(params).toEqual([]);
  });

  it("builds an ILIKE name predicate with escaped wildcards", () => {
    const { clause, params } = memberRosterWhere({
      q: "50%_off",
      status: "all",
      page: 1,
    });
    expect(clause).toBe("where full_name ilike $1 escape '\\'");
    expect(params).toEqual(["%50\\%\\_off%"]);
  });

  it("builds a status predicate", () => {
    const { clause, params } = memberRosterWhere({
      q: "",
      status: "inactive",
      page: 1,
    });
    expect(clause).toBe("where status = $1");
    expect(params).toEqual(["inactive"]);
  });

  it("combines name + status with sequential placeholders", () => {
    const { clause, params } = memberRosterWhere({
      q: "Jane",
      status: "active",
      page: 1,
    });
    expect(clause).toBe("where full_name ilike $1 escape '\\' and status = $2");
    expect(params).toEqual(["%Jane%", "active"]);
  });
});

describe("rosterPageCount", () => {
  it("is at least 1 even with no rows", () => {
    expect(rosterPageCount(0, 20)).toBe(1);
  });

  it("rounds up partial pages", () => {
    expect(rosterPageCount(20, 20)).toBe(1);
    expect(rosterPageCount(21, 20)).toBe(2);
    expect(rosterPageCount(41, 20)).toBe(3);
  });
});
