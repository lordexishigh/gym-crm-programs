import { describe, expect, it } from "vitest";
import { validateClassInput } from "../lib/classes";

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
