import { describe, expect, it } from "vitest";
import {
  IMPORT_MAX_ROWS,
  SAMPLE_CSV,
  mapHeaders,
  parseCsvRows,
  parseMemberCsv,
  sniffDelimiter,
} from "../lib/member-import";

/**
 * Unit tests for bulk CSV member import. Pure functions — no DB. The same module
 * powers both the browser preview and the Server Action, so these assertions
 * cover what actually gets written, not just what is displayed.
 */

describe("sniffDelimiter", () => {
  it("defaults to a comma", () => {
    expect(sniffDelimiter("full_name,email\nJane,j@x.com")).toBe(",");
  });

  it("detects semicolon-separated exports (European Excel)", () => {
    expect(sniffDelimiter("full_name;email;phone\nJane;j@x.com;123")).toBe(";");
  });

  it("detects tab-separated exports", () => {
    expect(sniffDelimiter("full_name\temail\nJane\tj@x.com")).toBe("\t");
  });

  it("ignores delimiters inside quoted header cells", () => {
    expect(sniffDelimiter('"name, full";email;phone\nJane;j@x.com;1')).toBe(";");
  });
});

describe("parseCsvRows", () => {
  it("parses simple rows and trims cells", () => {
    expect(parseCsvRows("a, b\n1 ,2")).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["1", "2"] },
    ]);
  });

  it("handles quoted fields, escaped quotes and embedded commas", () => {
    const rows = parseCsvRows('name,notes\nJane,"Knee, left, ""do not"" load"');
    expect(rows[1].cells).toEqual(["Jane", 'Knee, left, "do not" load']);
  });

  it("keeps a bare quote inside an unquoted field", () => {
    expect(parseCsvRows('a\nHe said "hi"')[1].cells).toEqual(['He said "hi"']);
  });

  it("handles CRLF line endings and a BOM", () => {
    expect(parseCsvRows("﻿a,b\r\n1,2\r\n")).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["1", "2"] },
    ]);
  });

  it("tracks source line numbers across a newline inside a quoted field", () => {
    const rows = parseCsvRows('name,notes\nJane,"line one\nline two"\nBob,x');
    expect(rows[1]).toEqual({ line: 2, cells: ["Jane", "line one\nline two"] });
    // Bob starts on physical line 4 because Jane's note spanned two lines.
    expect(rows[2]).toEqual({ line: 4, cells: ["Bob", "x"] });
  });

  it("drops blank rows and a missing trailing newline is fine", () => {
    expect(parseCsvRows("a\n\n\nb")).toEqual([
      { line: 1, cells: ["a"] },
      { line: 4, cells: ["b"] },
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(parseCsvRows("")).toEqual([]);
  });
});

describe("mapHeaders", () => {
  it("maps aliases case- and punctuation-insensitively", () => {
    const { mapped } = mapHeaders(["Full Name", "E-Mail", "Mobile Number"]);
    expect(mapped.map((m) => m.column)).toEqual(["fullName", "email", "phone"]);
    expect(mapped.map((m) => m.index)).toEqual([0, 1, 2]);
  });

  it("reports unrecognised headers as ignored, not as an error", () => {
    const { mapped, ignored } = mapHeaders(["Name", "Locker number"]);
    expect(mapped.map((m) => m.column)).toEqual(["fullName"]);
    expect(ignored).toEqual(["Locker number"]);
  });

  it("keeps the first of two headers claiming the same column", () => {
    const { mapped, ignored } = mapHeaders(["Name", "Phone", "Mobile"]);
    expect(mapped.filter((m) => m.column === "phone")).toHaveLength(1);
    expect(mapped.find((m) => m.column === "phone")?.index).toBe(1);
    expect(ignored).toEqual(["Mobile"]);
  });

  it("distinguishes emergency contact name from phone", () => {
    const { mapped } = mapHeaders(["name", "Emergency Contact Name", "Emergency Phone"]);
    expect(mapped.map((m) => m.column)).toEqual([
      "fullName",
      "emergencyContactName",
      "emergencyContactPhone",
    ]);
  });
});

describe("parseMemberCsv", () => {
  it("parses a well-formed file into importable rows", () => {
    const preview = parseMemberCsv(
      "full_name,email,phone\nJane Athlete,JANE@Example.com,+357 99 123456\nBob Lifter,,",
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[0]).toEqual({
      line: 2,
      input: {
        fullName: "Jane Athlete",
        email: "jane@example.com",
        phone: "+357 99 123456",
        status: "active",
        notes: null,
        photoUrl: null,
        emergencyContactName: null,
        emergencyContactPhone: null,
        membershipStatus: "active",
      },
    });
    expect(preview.rows[1].input.email).toBe(null);
    expect(preview.issues).toEqual([]);
  });

  it("rejects a file with no recognisable name column", () => {
    const preview = parseMemberCsv("email,phone\nj@x.com,123");
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error).toContain("No name column found");
  });

  it("rejects an empty file", () => {
    expect(parseMemberCsv("").ok).toBe(false);
    expect(parseMemberCsv("   \n  ").ok).toBe(false);
  });

  it("rejects a header row with no members under it", () => {
    const preview = parseMemberCsv("full_name,email");
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error).toContain("no members");
  });

  it("rejects a file over the row limit", () => {
    const body = Array.from(
      { length: IMPORT_MAX_ROWS + 1 },
      (_, i) => `Member ${i}`,
    ).join("\n");
    const preview = parseMemberCsv(`full_name\n${body}`);
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error).toContain(String(IMPORT_MAX_ROWS));
  });

  it("keeps good rows and reports bad ones per line", () => {
    const preview = parseMemberCsv(
      [
        "full_name,email",
        "Jane Athlete,jane@example.com",
        ",orphan@example.com",
        "Bad Email,not-an-email",
        "Bob Lifter,bob@example.com",
      ].join("\n"),
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.rows.map((r) => r.input.fullName)).toEqual([
      "Jane Athlete",
      "Bob Lifter",
    ]);
    expect(preview.issues.map((i) => i.line)).toEqual([3, 4]);
    expect(preview.issues[0].message).toContain("Full name is required");
    expect(preview.issues[1].message).toContain("valid email");
    expect(preview.issues[1].label).toBe("Bad Email");
  });

  it("rejects the second row that repeats an email, pointing at the first", () => {
    const preview = parseMemberCsv(
      "full_name,email\nJane A,jane@example.com\nJane Again,JANE@example.com",
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.rows).toHaveLength(1);
    expect(preview.issues).toHaveLength(1);
    expect(preview.issues[0].line).toBe(3);
    expect(preview.issues[0].message).toContain("line 2");
  });

  it("allows many rows with no email (they cannot be de-duplicated)", () => {
    const preview = parseMemberCsv("full_name,email\nJane,\nBob,\nSam,");
    expect(preview.ok && preview.rows).toHaveLength(3);
  });

  it("normalises status casing and common synonyms", () => {
    const preview = parseMemberCsv(
      [
        "name,status,membership",
        "A,Active,Active",
        "B,ARCHIVED,Paused",
        "C,,Canceled",
        "D,Enabled,Lapsed",
      ].join("\n"),
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.rows.map((r) => r.input.status)).toEqual([
      "active",
      "inactive",
      "active",
      "active",
    ]);
    expect(preview.rows.map((r) => r.input.membershipStatus)).toEqual([
      "active",
      "frozen",
      "cancelled",
      "expired",
    ]);
  });

  it("still rejects a status value it cannot map", () => {
    const preview = parseMemberCsv("name,status\nA,platinum");
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.rows).toHaveLength(0);
    expect(preview.issues[0].message).toContain("active or inactive");
  });

  it("parses a semicolon-separated file with quoted notes", () => {
    const preview = parseMemberCsv(
      'Name;Email;Notes\nElena Georgiou;elena@example.com;"Shoulder; go easy"',
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.delimiter).toBe(";");
    expect(preview.rows[0].input.notes).toBe("Shoulder; go easy");
  });

  it("tolerates short rows and ignores extra trailing cells", () => {
    const preview = parseMemberCsv(
      "full_name,email,phone\nJane\nBob,b@x.com,+357 99 000111,extra",
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[0].input.email).toBe(null);
    expect(preview.rows[1].input.phone).toBe("+357 99 000111");
  });

  it("applies the same field rules as the single-member form", () => {
    // A too-short phone is rejected by validateMemberInput; the import must not
    // quietly relax the shared rules, it must report the offending line.
    const preview = parseMemberCsv("full_name,phone\nBob,1");
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.rows).toHaveLength(0);
    expect(preview.issues[0]).toMatchObject({ line: 2, label: "Bob" });
    expect(preview.issues[0].message).toContain("valid phone");
  });

  it("surfaces unrecognised columns without failing the import", () => {
    const preview = parseMemberCsv("Name,Locker\nJane,42");
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.ignored).toEqual(["Locker"]);
    expect(preview.rows).toHaveLength(1);
  });

  it("accepts its own template CSV", () => {
    const preview = parseMemberCsv(SAMPLE_CSV);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.issues).toEqual([]);
    expect(preview.rows).toHaveLength(3);
    expect(preview.rows[0].input.notes).toBe("Knee rehab — no deep squats");
    expect(preview.rows[2].input.membershipStatus).toBe("cancelled");
  });
});
