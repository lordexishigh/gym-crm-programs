import { describe, expect, it } from "vitest";
import { validateMemberInput } from "../lib/members";

/**
 * Unit tests for member input validation (mvp-member-management-001).
 * Pure function — no DB. Asserts required-field enforcement, email handling,
 * and normalisation.
 */
describe("validateMemberInput", () => {
  it("accepts a full name only (email optional)", () => {
    const r = validateMemberInput({ fullName: "Jane Athlete" });
    expect(r).toEqual({
      ok: true,
      value: { fullName: "Jane Athlete", email: null, status: "active" },
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
      status: "active",
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

  it("rejects an out-of-range status", () => {
    expect(
      validateMemberInput({ fullName: "X", status: "deleted" }).ok,
    ).toBe(false);
  });

  it("accepts an explicit inactive status", () => {
    const r = validateMemberInput({ fullName: "X", status: "inactive" });
    expect(r.ok && r.value.status).toBe("inactive");
  });
});
