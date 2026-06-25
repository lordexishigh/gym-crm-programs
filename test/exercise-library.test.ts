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
      value: {
        name: "Back squat",
        sets: 5,
        reps: "5",
        rest: "90s",
        notes: null,
        category: null,
        imageUrl: null,
        instructions: null,
        guidelines: null,
        tips: null,
      },
    });
  });

  it("normalises rich reference content", () => {
    const r = validateLibraryExerciseInput({
      name: "Plank",
      category: "  Core  ",
      imageUrl: "https://cdn.example.com/plank.jpg",
      instructions: "  Brace and hold.  ",
      guidelines: "Keep hips level.",
      tips: "  ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.category).toBe("Core");
      expect(r.value.imageUrl).toBe("https://cdn.example.com/plank.jpg");
      expect(r.value.instructions).toBe("Brace and hold.");
      expect(r.value.guidelines).toBe("Keep hips level.");
      expect(r.value.tips).toBeNull();
    }
  });

  it("rejects a non-http(s) image URL", () => {
    expect(
      validateLibraryExerciseInput({ name: "X", imageUrl: "ftp://x/y.jpg" }).ok,
    ).toBe(false);
    expect(
      validateLibraryExerciseInput({ name: "X", imageUrl: "not a url" }).ok,
    ).toBe(false);
  });

  it("accepts a blank image URL as null", () => {
    const r = validateLibraryExerciseInput({ name: "X", imageUrl: "  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.imageUrl).toBeNull();
  });

  it("rejects over-long instructions", () => {
    const r = validateLibraryExerciseInput({
      name: "X",
      instructions: "i".repeat(4001),
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an over-long category", () => {
    const r = validateLibraryExerciseInput({
      name: "X",
      category: "c".repeat(81),
    });
    expect(r.ok).toBe(false);
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
