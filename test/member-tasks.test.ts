import { describe, expect, it } from "vitest";
import { validateMemberTaskInput } from "../lib/member-tasks";
import { taskUrgency } from "../app/dashboard/members/task-model";

/**
 * Pure validation + classification tests for trainer follow-up tasks
 * (CRM-IDEAS "Apply now" #5). No database: `validateMemberTaskInput` and
 * `taskUrgency` are pure functions, mirroring workout-logs.test.ts.
 * `taskUrgency` lives in app/dashboard/members/task-model.ts, not
 * lib/member-tasks.ts — see that file's header for why (client-bundle split).
 */
describe("validateMemberTaskInput", () => {
  it("accepts a minimal valid task (title only)", () => {
    const r = validateMemberTaskInput({ title: "Check in with Maria" });
    expect(r).toEqual({
      ok: true,
      value: { title: "Check in with Maria", dueAt: null },
    });
  });

  it("trims the title and requires it non-empty", () => {
    expect(validateMemberTaskInput({ title: "  padded  " })).toEqual({
      ok: true,
      value: { title: "padded", dueAt: null },
    });
    expect(validateMemberTaskInput({ title: "" }).ok).toBe(false);
    expect(validateMemberTaskInput({ title: "   " }).ok).toBe(false);
    expect(validateMemberTaskInput({}).ok).toBe(false);
  });

  it("rejects a title over the length cap", () => {
    const r = validateMemberTaskInput({ title: "x".repeat(301) });
    expect(r.ok).toBe(false);
  });

  it("normalises a due date to an ISO timestamp", () => {
    const r = validateMemberTaskInput({
      title: "Follow up",
      dueAt: "2026-08-01",
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.dueAt).toBe(new Date("2026-08-01").toISOString());
  });

  it("treats a blank due date as no due date", () => {
    const r = validateMemberTaskInput({ title: "Follow up", dueAt: "" });
    expect(r.ok && r.value.dueAt).toBeNull();
  });

  it("rejects an invalid due date", () => {
    const r = validateMemberTaskInput({
      title: "Follow up",
      dueAt: "not-a-date",
    });
    expect(r.ok).toBe(false);
  });
});

describe("taskUrgency", () => {
  const now = new Date("2026-07-26T12:00:00.000Z");

  it("is 'done' whenever completed_at is set, regardless of due date", () => {
    expect(
      taskUrgency(
        { due_at: "2020-01-01T00:00:00.000Z", completed_at: "2026-07-01T00:00:00.000Z" },
        now,
      ),
    ).toBe("done");
  });

  it("is 'none' for an open task with no due date", () => {
    expect(taskUrgency({ due_at: null, completed_at: null }, now)).toBe("none");
  });

  it("is 'overdue' for a due date before today", () => {
    expect(
      taskUrgency({ due_at: "2026-07-25T23:59:00.000Z", completed_at: null }, now),
    ).toBe("overdue");
  });

  it("is 'due-today' for a due date on today's calendar date, any hour", () => {
    expect(
      taskUrgency({ due_at: "2026-07-26T00:00:00.000Z", completed_at: null }, now),
    ).toBe("due-today");
    expect(
      taskUrgency({ due_at: "2026-07-26T23:59:00.000Z", completed_at: null }, now),
    ).toBe("due-today");
  });

  it("is 'upcoming' for a due date after today", () => {
    expect(
      taskUrgency({ due_at: "2026-07-27T00:00:00.000Z", completed_at: null }, now),
    ).toBe("upcoming");
  });
});
