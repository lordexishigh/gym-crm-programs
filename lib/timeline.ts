import type {
  MemberAssignmentEvent,
  MemberInviteEvent,
  MemberStatusEvent,
} from "./member-records";
import type { WorkoutLogRow } from "./workout-logs";

/**
 * Member-detail activity timeline (CRM-IDEAS "Apply now" #4).
 *
 * Merges the member's status changes, program assignments, invite events, and
 * logged workouts — each already read under RLS by the caller — into one
 * chronological feed, newest first. PURE (no DB, no env): it only reshapes and
 * sorts data the page already fetched, so it is unit-testable in isolation and
 * mirrors the `validate*Input` convention (`lib/workout-logs.ts`,
 * `lib/programs.ts`). Isolation is unaffected — every input array is already
 * RLS-scoped to the caller's own gym/member before it reaches this function.
 */
export type TimelineEntry =
  | {
      kind: "status";
      occurredAt: string;
      oldStatus: MemberStatusEvent["old_status"];
      newStatus: MemberStatusEvent["new_status"];
      changedByName: string | null;
    }
  | {
      kind: "assignment";
      occurredAt: string;
      programName: string;
      status: MemberAssignmentEvent["status"];
    }
  | { kind: "invite-sent"; occurredAt: string; email: string }
  | { kind: "invite-accepted"; occurredAt: string; email: string }
  | {
      kind: "workout";
      occurredAt: string;
      programName: string;
      effort: number | null;
      note: string | null;
    };

export function buildMemberTimeline(input: {
  statusEvents: MemberStatusEvent[];
  assignmentEvents: MemberAssignmentEvent[];
  inviteEvents: MemberInviteEvent[];
  workoutLogs: WorkoutLogRow[];
}): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const e of input.statusEvents) {
    entries.push({
      kind: "status",
      occurredAt: e.changed_at,
      oldStatus: e.old_status,
      newStatus: e.new_status,
      changedByName: e.changed_by_name,
    });
  }

  for (const a of input.assignmentEvents) {
    entries.push({
      kind: "assignment",
      occurredAt: a.assigned_at,
      programName: a.program_name,
      status: a.status,
    });
  }

  for (const inv of input.inviteEvents) {
    entries.push({ kind: "invite-sent", occurredAt: inv.created_at, email: inv.email });
    if (inv.accepted_at) {
      entries.push({
        kind: "invite-accepted",
        occurredAt: inv.accepted_at,
        email: inv.email,
      });
    }
  }

  for (const w of input.workoutLogs) {
    entries.push({
      kind: "workout",
      occurredAt: w.completed_at,
      programName: w.program_name,
      effort: w.effort,
      note: w.note,
    });
  }

  return entries.sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );
}
