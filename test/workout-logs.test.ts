import { describe, expect, it } from "vitest";
import { validateWorkoutLogInput } from "../lib/workout-logs";

/**
 * Pure validation tests for workout logging (Phase GA — ga-engagement-001).
 *
 * No database: `validateWorkoutLogInput` is a pure function that runs in the
 * Server Action before any query, so this asserts the friendly-error rules in
 * isolation (mirrors programs.test.ts / members.test.ts).
 */
const PROGRAM_ID = "11111111-2222-3333-4444-555555555555";

describe("validateWorkoutLogInput", () => {
  it("accepts a minimal valid log (program only)", () => {
    const r = validateWorkoutLogInput({ programId: PROGRAM_ID });
    expect(r).toEqual({
      ok: true,
      value: { programId: PROGRAM_ID, effort: null, note: null },
    });
  });

  it("accepts effort and note and trims the note", () => {
    const r = validateWorkoutLogInput({
      programId: PROGRAM_ID,
      effort: "8",
      note: "  felt strong  ",
    });
    expect(r).toEqual({
      ok: true,
      value: { programId: PROGRAM_ID, effort: 8, note: "felt strong" },
    });
  });

  it("requires a program id", () => {
    expect(validateWorkoutLogInput({ programId: "" }).ok).toBe(false);
    expect(validateWorkoutLogInput({}).ok).toBe(false);
  });

  it("rejects a program id that is not a uuid", () => {
    const r = validateWorkoutLogInput({ programId: "not-a-uuid" });
    expect(r.ok).toBe(false);
  });

  it("rejects effort outside 1..10 and non-integers", () => {
    expect(validateWorkoutLogInput({ programId: PROGRAM_ID, effort: "0" }).ok).toBe(
      false,
    );
    expect(
      validateWorkoutLogInput({ programId: PROGRAM_ID, effort: "11" }).ok,
    ).toBe(false);
    expect(
      validateWorkoutLogInput({ programId: PROGRAM_ID, effort: "7.5" }).ok,
    ).toBe(false);
  });

  it("treats blank effort as null (optional)", () => {
    const r = validateWorkoutLogInput({ programId: PROGRAM_ID, effort: "" });
    expect(r.ok && r.value.effort).toBe(null);
  });

  it("rejects a note over the length cap", () => {
    const r = validateWorkoutLogInput({
      programId: PROGRAM_ID,
      note: "x".repeat(1001),
    });
    expect(r.ok).toBe(false);
  });
});
