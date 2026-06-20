import { describe, expect, it } from "vitest";
import { validateProgramInput } from "../lib/programs";

/**
 * Unit tests for program input validation (mvp-program-001/002).
 * Pure function — no DB. Asserts name enforcement, exercise field handling,
 * sets coercion, order preservation, and normalisation.
 */
describe("validateProgramInput", () => {
  it("accepts a name with no exercises (draft program)", () => {
    const r = validateProgramInput({ name: "Phase 1" });
    expect(r).toEqual({
      ok: true,
      value: { name: "Phase 1", description: null, exercises: [] },
    });
  });

  it("rejects a missing/blank name", () => {
    expect(validateProgramInput({ name: "   " }).ok).toBe(false);
    expect(validateProgramInput({}).ok).toBe(false);
  });

  it("preserves exercise order and captures every field exactly", () => {
    const r = validateProgramInput({
      name: "Strength",
      exercises: [
        { name: "Squat", sets: "5", reps: "5", rest: "120s", notes: "neutral back" },
        { name: "Bench", sets: 3, reps: "8-12", rest: "90s", notes: "" },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.exercises).toEqual([
      { name: "Squat", sets: 5, reps: "5", rest: "120s", notes: "neutral back" },
      { name: "Bench", sets: 3, reps: "8-12", rest: "90s", notes: null },
    ]);
  });

  it("treats blank sets/reps/rest/notes as null", () => {
    const r = validateProgramInput({
      name: "P",
      exercises: [{ name: "Plank", sets: "", reps: " ", rest: "", notes: "" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.exercises[0]).toEqual({
      name: "Plank",
      sets: null,
      reps: null,
      rest: null,
      notes: null,
    });
  });

  it("requires each exercise to have a name", () => {
    const r = validateProgramInput({
      name: "P",
      exercises: [{ name: "  ", sets: "3" }],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects non-integer or negative sets", () => {
    expect(
      validateProgramInput({
        name: "P",
        exercises: [{ name: "Squat", sets: "3.5" }],
      }).ok,
    ).toBe(false);
    expect(
      validateProgramInput({
        name: "P",
        exercises: [{ name: "Squat", sets: "-1" }],
      }).ok,
    ).toBe(false);
    expect(
      validateProgramInput({
        name: "P",
        exercises: [{ name: "Squat", sets: "abc" }],
      }).ok,
    ).toBe(false);
  });

  it("trims the program name", () => {
    const r = validateProgramInput({ name: "  Hypertrophy  " });
    expect(r.ok && r.value.name).toBe("Hypertrophy");
  });

  it("rejects exercises that are not a list", () => {
    expect(validateProgramInput({ name: "P", exercises: "nope" }).ok).toBe(
      false,
    );
  });
});
