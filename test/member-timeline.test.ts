import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Timeline } from "../app/dashboard/members/Timeline";
import { buildMemberTimeline, type TimelineEntry } from "../lib/timeline";

/**
 * Member-detail activity timeline (CRM-IDEAS "Apply now" #4).
 *
 * `buildMemberTimeline` is PURE — no DB — so these pin the merge/sort contract
 * directly. The view tests render to static markup, mirroring
 * `program-history-view.test.ts` / the removed `member-status-history-view`.
 */
describe("buildMemberTimeline", () => {
  it("merges all four sources and sorts newest first", () => {
    const entries = buildMemberTimeline({
      statusEvents: [
        {
          old_status: "active",
          new_status: "inactive",
          changed_at: "2026-01-03T00:00:00.000Z",
          changed_by_name: "Coach Sam",
        },
      ],
      assignmentEvents: [
        {
          program_name: "Phase 1",
          status: "active",
          assigned_at: "2026-01-02T00:00:00.000Z",
        },
      ],
      inviteEvents: [
        {
          email: "jane@example.com",
          status: "accepted",
          created_at: "2026-01-01T00:00:00.000Z",
          accepted_at: "2026-01-01T12:00:00.000Z",
        },
      ],
      workoutLogs: [
        {
          id: "log-1",
          program_id: "prog-1",
          program_name: "Phase 1",
          completed_at: "2026-01-04T00:00:00.000Z",
          effort: 7,
          note: null,
        },
      ],
    });

    expect(entries.map((e) => e.kind)).toEqual([
      "workout",
      "status",
      "assignment",
      "invite-accepted",
      "invite-sent",
    ]);
    // Newest first.
    expect(entries[0].occurredAt).toBe("2026-01-04T00:00:00.000Z");
    expect(entries[entries.length - 1].occurredAt).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("emits only a 'sent' event for a pending invite (no accepted_at)", () => {
    const entries = buildMemberTimeline({
      statusEvents: [],
      assignmentEvents: [],
      inviteEvents: [
        {
          email: "jane@example.com",
          status: "pending",
          created_at: "2026-01-01T00:00:00.000Z",
          accepted_at: null,
        },
      ],
      workoutLogs: [],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("invite-sent");
  });

  it("returns an empty list when every source is empty", () => {
    expect(
      buildMemberTimeline({
        statusEvents: [],
        assignmentEvents: [],
        inviteEvents: [],
        workoutLogs: [],
      }),
    ).toEqual([]);
  });
});

describe("Timeline view", () => {
  const render = (entries: TimelineEntry[]) =>
    renderToStaticMarkup(createElement(Timeline, { entries }));

  it("renders a status, assignment, invite, and workout entry", () => {
    const html = render([
      {
        kind: "status",
        occurredAt: "2026-01-04T09:30:00.000Z",
        oldStatus: "active",
        newStatus: "inactive",
        changedByName: "Coach Sam",
      },
      {
        kind: "assignment",
        occurredAt: "2026-01-03T00:00:00.000Z",
        programName: "Phase 1",
        status: "archived",
      },
      { kind: "invite-sent", occurredAt: "2026-01-02T00:00:00.000Z", email: "jane@example.com" },
      {
        kind: "workout",
        occurredAt: "2026-01-01T00:00:00.000Z",
        programName: "Phase 1",
        effort: 8,
        note: "Felt strong",
      },
    ]);

    expect(html).toContain("Activity");
    expect(html).toContain("Status changed: active → inactive");
    expect(html).toContain("Coach Sam");
    expect(html).toContain("Program assigned: Phase 1 (now archived)");
    expect(html).toContain("Invite sent to jane@example.com");
    expect(html).toContain("Logged a workout: Phase 1");
    expect(html).toContain("Effort 8/10");
    expect(html).toContain("Felt strong");
    expect(html).toContain("2026-01-04 09:30 UTC");
  });

  it("shows a heading and empty message when there is no activity", () => {
    const html = render([]);
    expect(html).toContain("Activity");
    expect(html).toContain("No activity recorded yet.");
  });

  it("exposes no editing affordances (read-only)", () => {
    const html = render([
      {
        kind: "status",
        occurredAt: "2026-01-01T00:00:00.000Z",
        oldStatus: null,
        newStatus: "active",
        changedByName: null,
      },
    ]);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });
});
