import { describe, expect, it } from "vitest";
import { currentStreakDays, validateWorkoutLogInput } from "../lib/workout-logs";

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

/**
 * Pure streak-calculation tests (engagement layer, CRM-IDEAS "Next" #7). No
 * database: `currentStreakDays` only reshapes already-fetched timestamps, so
 * these pin the day-bucketing/anchoring contract directly, mirroring
 * `taskUrgency`'s pure-classifier tests.
 */
describe("currentStreakDays", () => {
  const log = (iso: string) => ({ completed_at: iso });
  const now = new Date("2026-07-27T18:00:00.000Z");

  it("is 0 with no logs", () => {
    expect(currentStreakDays([], now)).toBe(0);
  });

  it("counts a single session logged today as a 1-day streak", () => {
    expect(currentStreakDays([log("2026-07-27T09:00:00.000Z")], now)).toBe(1);
  });

  it("counts consecutive prior days logged today", () => {
    const logs = [
      log("2026-07-27T09:00:00.000Z"),
      log("2026-07-26T09:00:00.000Z"),
      log("2026-07-25T09:00:00.000Z"),
    ];
    expect(currentStreakDays(logs, now)).toBe(3);
  });

  it("stops counting at the first missed day", () => {
    const logs = [
      log("2026-07-27T09:00:00.000Z"),
      log("2026-07-26T09:00:00.000Z"),
      // 2026-07-25 missing
      log("2026-07-24T09:00:00.000Z"),
    ];
    expect(currentStreakDays(logs, now)).toBe(2);
  });

  it("still counts the streak when today has no session yet, anchoring on yesterday", () => {
    const logs = [
      log("2026-07-26T09:00:00.000Z"),
      log("2026-07-25T09:00:00.000Z"),
    ];
    expect(currentStreakDays(logs, now)).toBe(2);
  });

  it("is 0 when the most recent session was before yesterday (streak broken)", () => {
    expect(currentStreakDays([log("2026-07-24T09:00:00.000Z")], now)).toBe(0);
  });

  it("counts multiple sessions on the same day as one", () => {
    const logs = [
      log("2026-07-27T08:00:00.000Z"),
      log("2026-07-27T19:00:00.000Z"),
    ];
    expect(currentStreakDays(logs, now)).toBe(1);
  });
});
