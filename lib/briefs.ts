import { withTenantContext, type Identity } from "@/lib/db";
import { ADHERENCE_WINDOW_DAYS } from "@/lib/workout-logs";
import { createSuggestion, type Observation } from "@/lib/suggestions";

/**
 * At-risk briefs: the sentence a trainer can act on, assembled from rows.
 *
 * The roster already answers "who went quiet" — `memberEngagementLevel`
 * (lib/workout-logs.ts) badges a member at-risk once they have trained before
 * and logged nothing inside the adherence window. What it cannot do is tell a
 * trainer anything about the situation. A badge says "something is wrong with
 * this person"; it does not say what, since when, or against which program, so
 * the trainer opens the profile and re-derives it by hand for every flagged
 * member.
 *
 * This module writes that down instead. It is deliberately rules-and-template,
 * with no model involved, for three reasons:
 *
 *   - The facts are arithmetic. "0 sessions in 30 days, last was 3 July, on a
 *     program assigned 12 June" is a query result, not a judgement. Handing
 *     arithmetic to a generative model swaps a correct answer for a plausible
 *     one and calls it an upgrade.
 *   - The output must be identical for identical input, because it is written to
 *     an audit-relevant ledger and read as evidence for contacting a member
 *     about their health data.
 *   - It needs no API key, no data leaving the EU, and no per-suggestion cost —
 *     so it works on every deployment, including the one in production today
 *     (see lib/capabilities.ts: `ai` is unconfigured and expected to stay that
 *     way).
 *
 * A model would earn its place here only in tone and phrasing, which is the one
 * part that does not matter. So: rules decide, the template narrates, and the
 * evidence array carries the rows the trainer can open to check.
 *
 * Note on strength: a brief scores 'strong' under `priceEvidence` because every
 * observation is a first-party row observation. That is about whether the
 * NUMBERS can be trusted, not about acting without a human — `ledgerDisposition`
 * governs suggestions that propose a write, and a brief proposes none. Briefs
 * always go to the queue and a trainer always decides whether to reach out.
 */

/** The per-member facts a brief is assembled from. All first-party. */
export type AtRiskFacts = {
  memberId: string;
  memberName: string;
  /** Sessions ever logged by this member. */
  totalSessions: number;
  /** Sessions logged inside `windowDays`. */
  recentSessions: number;
  /** Most recent session timestamp (ISO), or null if never. */
  lastCompletedAt: string | null;
  /** Row id of that most recent session — the brief's anchor `ref`. */
  lastLogId: string | null;
  /** Active assignment, when the member has one. */
  activeProgramName: string | null;
  activeAssignmentId: string | null;
  assignedAt: string | null;
  windowDays: number;
};

export type AtRiskBrief = {
  memberId: string;
  headline: string;
  observations: Observation[];
  /** Whole days since the last logged session. */
  daysSinceLastSession: number;
  dedupeKey: string;
};

/** Versioned generator id written to `suggestions.source`. */
export const AT_RISK_SOURCE = "rules:at-risk-v1";
export const AT_RISK_KIND = "at_risk_brief";

/** Whole days between two instants, floored at 0. */
export function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/** `12 June 2026` — the format used in member-facing and staff-facing copy. */
function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { dateStyle: "long" });
}

/**
 * Build a brief from one member's facts, or null when there is nothing to say.
 *
 * PURE, so the wording and the rules are testable without a database and cannot
 * drift from what the roster badge decides.
 *
 * Returns null in the two cases that are not churn signals:
 *
 *   - the member logged inside the window (they are training; nothing to raise);
 *   - the member has never logged at all. This mirrors
 *     `memberEngagementLevel`'s "none" and matters: a member who never started
 *     is an onboarding problem, and filing them as at-risk would bury the
 *     members who DID start and then stopped — the ones a conversation can still
 *     save — under everyone who was added and never came in.
 */
export function buildAtRiskBrief(
  facts: AtRiskFacts,
  now: Date,
): AtRiskBrief | null {
  if (facts.recentSessions > 0) return null;
  if (facts.totalSessions === 0 || !facts.lastCompletedAt) return null;

  const lastAt = facts.lastCompletedAt;
  const gapDays = daysBetween(new Date(lastAt), now);

  const observations: Observation[] = [
    {
      source: "workout_log.last-session",
      observed: `Last logged session on ${formatDay(lastAt)} (${gapDays} days ago).`,
      ...(facts.lastLogId ? { ref: facts.lastLogId } : {}),
      at: lastAt,
    },
    {
      source: "workout_log.window-count",
      observed: `0 sessions logged in the last ${facts.windowDays} days; ${facts.totalSessions} logged in total.`,
    },
  ];

  if (facts.activeProgramName && facts.assignedAt) {
    observations.push({
      source: "program_assignment.active",
      observed: `Still assigned "${facts.activeProgramName}", given on ${formatDay(facts.assignedAt)}.`,
      ...(facts.activeAssignmentId ? { ref: facts.activeAssignmentId } : {}),
      at: facts.assignedAt,
    });
  } else {
    // Absence is itself actionable, and a trainer reading a brief needs to know
    // which of the two conversations to have: "you have a program and stopped
    // using it" or "you stopped, and nobody has given you anything to come back
    // to". Stating it explicitly also keeps the observation count at two, which
    // is what `priceEvidence` requires before it will price anything strong.
    observations.push({
      source: "program_assignment.none",
      observed: "No active program assigned.",
    });
  }

  const programClause = facts.activeProgramName
    ? ` Their assigned program "${facts.activeProgramName}" is going unused.`
    : " They have no active program to come back to.";

  return {
    memberId: facts.memberId,
    headline: `${facts.memberName} has not trained in ${gapDays} days (last session ${formatDay(lastAt)}).${programClause}`,
    observations,
    daysSinceLastSession: gapDays,
    // The occasion is the member's silence as measured this WEEK. A daily
    // generator would otherwise raise a fresh brief every morning for the same
    // quiet member and bury the trainer in duplicates; an ISO week keeps it to
    // one nudge per member per week, while still re-raising if they stay quiet.
    dedupeKey: `${facts.memberId}:${isoWeek(now)}`,
  };
}

/**
 * `2026-W31` — ISO-8601 week, used as the dedupe occasion.
 *
 * Computed rather than pulled from a library because it is eight lines and the
 * project has no date dependency. Thursday-based, per ISO: the week containing
 * the year's first Thursday is week 1.
 */
export function isoWeek(when: Date): string {
  const d = new Date(
    Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate()),
  );
  // Shift to the Thursday of this ISO week (day 4, with Sunday as 7).
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * One query gathering the facts for every at-risk member in the gym.
 *
 * Deliberately a single aggregate pass rather than per-member queries: the
 * roster learned this lesson already (see `rosterListSql` in lib/members.ts),
 * and here it matters more because this runs unattended for every tenant in one
 * dispatcher invocation, against a pool capped at 3 connections.
 *
 * RLS scopes every CTE to the caller's gym, so no query below carries a
 * tenant predicate and a cross-tenant member cannot appear in the result.
 */
const AT_RISK_FACTS_SQL = `
with logs as (
  select member_id,
         count(*)::int as total_sessions,
         count(*) filter (where completed_at >= now() - make_interval(days => $1))::int
           as recent_sessions
    from workout_log
   group by member_id
),
last_log as (
  select distinct on (member_id) member_id, id as log_id, completed_at
    from workout_log
   order by member_id, completed_at desc
),
active_assignment as (
  select distinct on (pa.member_id)
         pa.member_id, pa.id as assignment_id, p.name as program_name,
         pa.assigned_at
    from program_assignment pa
    join program p on p.id = pa.program_id
   where pa.status = 'active'
   order by pa.member_id, pa.assigned_at desc
)
select m.id                                as member_id,
       m.full_name                         as member_name,
       coalesce(l.total_sessions, 0)       as total_sessions,
       coalesce(l.recent_sessions, 0)      as recent_sessions,
       ll.completed_at                     as last_completed_at,
       ll.log_id                           as last_log_id,
       aa.program_name                     as active_program_name,
       aa.assignment_id                    as active_assignment_id,
       aa.assigned_at                      as assigned_at
  from member m
  left join logs             l  on l.member_id  = m.id
  left join last_log         ll on ll.member_id = m.id
  left join active_assignment aa on aa.member_id = m.id
 where m.status = 'active'
   and coalesce(l.total_sessions, 0)  > 0
   and coalesce(l.recent_sessions, 0) = 0
 order by ll.completed_at asc`;

/** Gather at-risk facts for the caller's gym. Staff identity required. */
export async function atRiskFacts(
  identity: Identity,
  windowDays: number = ADHERENCE_WINDOW_DAYS,
): Promise<AtRiskFacts[]> {
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<{
      member_id: string;
      member_name: string;
      total_sessions: number;
      recent_sessions: number;
      last_completed_at: string | null;
      last_log_id: string | null;
      active_program_name: string | null;
      active_assignment_id: string | null;
      assigned_at: string | null;
    }>(AT_RISK_FACTS_SQL, [windowDays]);

    return rows.map((r) => ({
      memberId: r.member_id,
      memberName: r.member_name,
      totalSessions: Number(r.total_sessions ?? 0),
      recentSessions: Number(r.recent_sessions ?? 0),
      lastCompletedAt: r.last_completed_at,
      lastLogId: r.last_log_id,
      activeProgramName: r.active_program_name,
      activeAssignmentId: r.active_assignment_id,
      assignedAt: r.assigned_at,
      windowDays,
    }));
  });
}

/**
 * Generate this week's at-risk briefs for one gym and file them in the ledger.
 *
 * Returns how many were newly filed. Re-running is safe and cheap: the
 * suggestion dedupe key is `<member>:<iso-week>`, so a second run in the same
 * week files nothing, and `createSuggestion` swallows the conflict rather than
 * raising it.
 */
export async function generateAtRiskBriefs(
  identity: Identity,
  now: Date = new Date(),
  windowDays: number = ADHERENCE_WINDOW_DAYS,
): Promise<number> {
  const facts = await atRiskFacts(identity, windowDays);
  let filed = 0;

  for (const f of facts) {
    const brief = buildAtRiskBrief(f, now);
    if (!brief) continue;
    const created = await createSuggestion(identity, {
      kind: AT_RISK_KIND,
      memberId: brief.memberId,
      headline: brief.headline,
      detail: { daysSinceLastSession: brief.daysSinceLastSession, windowDays },
      observations: brief.observations,
      source: AT_RISK_SOURCE,
      dedupeKey: brief.dedupeKey,
    });
    if (created) filed += 1;
  }

  return filed;
}
