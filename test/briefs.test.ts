import { describe, expect, it } from "vitest";
import {
  buildAtRiskBrief,
  daysBetween,
  isoWeek,
  type AtRiskFacts,
} from "../lib/briefs";
import { priceEvidence } from "../lib/suggestions";

/**
 * At-risk brief generation.
 *
 * `buildAtRiskBrief` is pure so the RULES (who gets flagged) and the WORDING
 * (what the trainer reads) are both pinned without a database. The rules half
 * matters most: it must agree with `memberEngagementLevel`, which the roster
 * badge already uses, or the roster and this queue will disagree about who is at
 * risk and a trainer will not trust either.
 */

const NOW = new Date("2026-08-04T10:00:00Z");

const baseFacts: AtRiskFacts = {
  memberId: "55555555-5555-5555-5555-555555555555",
  memberName: "Maria Georgiou",
  totalSessions: 12,
  recentSessions: 0,
  lastCompletedAt: "2026-07-03T18:30:00Z",
  lastLogId: "66666666-6666-6666-6666-666666666666",
  activeProgramName: "Upper/Lower Split",
  activeAssignmentId: "77777777-7777-7777-7777-777777777777",
  assignedAt: "2026-06-12T09:00:00Z",
  windowDays: 30,
};

describe("daysBetween", () => {
  it("counts whole elapsed days", () => {
    expect(
      daysBetween(new Date("2026-08-01T00:00:00Z"), new Date("2026-08-04T00:00:00Z")),
    ).toBe(3);
  });

  it("floors a partial day", () => {
    expect(
      daysBetween(new Date("2026-08-01T00:00:00Z"), new Date("2026-08-04T23:59:00Z")),
    ).toBe(3);
  });

  it("never goes negative for a future timestamp", () => {
    // A clock skew between the app and the database must not produce
    // "trained -2 days ago".
    expect(
      daysBetween(new Date("2026-09-01T00:00:00Z"), new Date("2026-08-04T00:00:00Z")),
    ).toBe(0);
  });
});

describe("isoWeek", () => {
  it("formats as <year>-W<week>", () => {
    expect(isoWeek(new Date("2026-08-04T10:00:00Z"))).toMatch(/^2026-W\d{2}$/);
  });

  it("is stable across every day of one ISO week", () => {
    // The dedupe property: a daily generator must file ONE brief per member per
    // week, not seven.
    const monday = isoWeek(new Date("2026-08-03T00:00:00Z"));
    const sunday = isoWeek(new Date("2026-08-09T23:59:00Z"));
    expect(monday).toBe(sunday);
  });

  it("changes at the week boundary", () => {
    const sunday = isoWeek(new Date("2026-08-09T23:59:00Z"));
    const monday = isoWeek(new Date("2026-08-10T00:01:00Z"));
    expect(monday).not.toBe(sunday);
  });

  it("pads single-digit weeks so keys sort", () => {
    expect(isoWeek(new Date("2026-01-08T00:00:00Z"))).toBe("2026-W02");
  });
});

describe("buildAtRiskBrief", () => {
  it("flags a member who trained and then stopped", () => {
    const brief = buildAtRiskBrief(baseFacts, NOW);
    expect(brief).not.toBeNull();
    // 3 July 18:30 → 4 August 10:00 is 31 whole days plus 15.5 hours, and the
    // count is floored: "31 days" is true, "32 days" would not yet be.
    expect(brief!.daysSinceLastSession).toBe(31);
    expect(brief!.headline).toContain("Maria Georgiou");
    expect(brief!.headline).toContain("31 days");
    expect(brief!.headline).toContain("Upper/Lower Split");
  });

  it("says nothing about a member who logged inside the window", () => {
    expect(
      buildAtRiskBrief({ ...baseFacts, recentSessions: 3 }, NOW),
    ).toBeNull();
  });

  it("says nothing about a member who has never trained", () => {
    // Mirrors `memberEngagementLevel`'s "none". Filing these would bury the
    // members a conversation can still save under everyone who never came in.
    expect(
      buildAtRiskBrief(
        { ...baseFacts, totalSessions: 0, lastCompletedAt: null, lastLogId: null },
        NOW,
      ),
    ).toBeNull();
  });

  it("treats a missing last-session timestamp as nothing to say", () => {
    // Defensive: totalSessions > 0 with no timestamp is inconsistent data, and
    // the brief's whole content is "how long since". Better silent than wrong.
    expect(
      buildAtRiskBrief({ ...baseFacts, lastCompletedAt: null }, NOW),
    ).toBeNull();
  });

  it("carries the program in the evidence when one is assigned", () => {
    const brief = buildAtRiskBrief(baseFacts, NOW)!;
    const sources = brief.observations.map((o) => o.source);
    expect(sources).toContain("workout_log.last-session");
    expect(sources).toContain("workout_log.window-count");
    expect(sources).toContain("program_assignment.active");
  });

  it("states the absence of a program when there is none", () => {
    const brief = buildAtRiskBrief(
      {
        ...baseFacts,
        activeProgramName: null,
        activeAssignmentId: null,
        assignedAt: null,
      },
      NOW,
    )!;
    expect(brief.observations.map((o) => o.source)).toContain(
      "program_assignment.none",
    );
    expect(brief.headline).toContain("no active program");
    // Still two observations, which is what `priceEvidence` needs before it
    // will price anything strong.
    expect(brief.observations.length).toBeGreaterThanOrEqual(2);
  });

  it("produces evidence the ledger prices as strong", () => {
    // Every observation is read from our own rows, and the last session is
    // anchored to a real log id — so the numbers can be trusted as stated.
    const brief = buildAtRiskBrief(baseFacts, NOW)!;
    expect(priceEvidence(brief.observations)).toBe("strong");
  });

  it("stays strong on the assignment anchor alone when the log id is missing", () => {
    // `priceEvidence` needs at least ONE anchored observation, not all of them.
    // With no log id the active assignment still points at a real row, so the
    // claim remains checkable and the pricing holds.
    const brief = buildAtRiskBrief({ ...baseFacts, lastLogId: null }, NOW)!;
    expect(priceEvidence(brief.observations)).toBe("strong");
  });

  it("prices as weak when nothing in the evidence points at a row", () => {
    const brief = buildAtRiskBrief(
      {
        ...baseFacts,
        lastLogId: null,
        activeProgramName: null,
        activeAssignmentId: null,
        assignedAt: null,
      },
      NOW,
    )!;
    expect(priceEvidence(brief.observations)).toBe("weak");
  });

  it("dedupes per member per ISO week", () => {
    const monday = buildAtRiskBrief(baseFacts, new Date("2026-08-03T08:00:00Z"))!;
    const friday = buildAtRiskBrief(baseFacts, new Date("2026-08-07T08:00:00Z"))!;
    const nextWeek = buildAtRiskBrief(
      baseFacts,
      new Date("2026-08-11T08:00:00Z"),
    )!;

    expect(monday.dedupeKey).toBe(friday.dedupeKey);
    expect(nextWeek.dedupeKey).not.toBe(monday.dedupeKey);
    expect(monday.dedupeKey.startsWith(baseFacts.memberId)).toBe(true);
  });

  it("is deterministic for identical input", () => {
    // Written to an audit-relevant ledger and read as the basis for contacting
    // a member about their health data, so identical facts must produce
    // identical text.
    expect(buildAtRiskBrief(baseFacts, NOW)).toEqual(
      buildAtRiskBrief(baseFacts, NOW),
    );
  });
});
