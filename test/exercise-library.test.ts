import { describe, expect, it } from "vitest";
import { validateLibraryExerciseInput } from "../lib/exercise-library";

/**
 * Unit tests for the pure library-exercise validator (alpha-exercise-library-001).
 * No DB — always runs.
 */
describe("validateLibraryExerciseInput", () => {
  it("requires a name", () => {
    const r = validateLibraryExerciseInput({ name: "   " });
    expect(r).toEqual({ ok: false, error: "Exercise name is required." });
  });

  it("normalises a full exercise (trims, nulls blanks)", () => {
    const r = validateLibraryExerciseInput({
      name: "  Back squat  ",
      sets: "5",
      reps: "5",
      rest: "90s",
      notes: "  ",
    });
    expect(r).toEqual({
      ok: true,
      value: { name: "Back squat", sets: 5, reps: "5", rest: "90s", notes: null },
    });
  });

  it("accepts a blank sets value as null", () => {
    const r = validateLibraryExerciseInput({ name: "Plank", sets: "" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.sets).toBeNull();
  });

  it("rejects non-integer / out-of-range sets", () => {
    expect(validateLibraryExerciseInput({ name: "X", sets: "2.5" }).ok).toBe(
      false,
    );
    expect(validateLibraryExerciseInput({ name: "X", sets: "-1" }).ok).toBe(
      false,
    );
    expect(validateLibraryExerciseInput({ name: "X", sets: "101" }).ok).toBe(
      false,
    );
  });

  it("rejects an over-long name", () => {
    const r = validateLibraryExerciseInput({ name: "a".repeat(201) });
    expect(r.ok).toBe(false);
  });

  it("rejects over-long free text", () => {
    const r = validateLibraryExerciseInput({
      name: "Curl",
      notes: "n".repeat(501),
    });
    expect(r.ok).toBe(false);
  });
});
