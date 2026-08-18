import { nextStreakMilestone, streakMilestoneReached } from "@/lib/workout-logs";

/**
 * Current-streak badge for the member portal (CRM-IDEAS "Next" #7 —
 * engagement layer: streaks & badges, scoped to the streak itself).
 *
 * Pure presentation: takes the already-computed streak length as a prop, so it
 * is unit-testable without a session or database, mirroring `WorkoutHistory` /
 * `ProgramHistory`. Renders nothing at 0 (no streak to show yet) so it never
 * displaces the "Log a workout" empty-state invitation.
 *
 * On a milestone day (`streakMilestoneReached`) the badge switches to a
 * distinct celebratory style; otherwise it shows a quiet hint of how many days
 * remain to the next one, so the milestone reads as an earned moment rather
 * than a number that silently changes color.
 */
export function StreakBadge({ days }: { days: number }) {
  if (days <= 0) return null;

  const label = days === 1 ? "1 day streak" : `${days} day streak`;
  const milestone = streakMilestoneReached(days);

  if (milestone !== null) {
    return (
      <p className="mt-6 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-700">
        <span aria-hidden>🏅</span>
        {label} — new milestone!
      </p>
    );
  }

  const next = nextStreakMilestone(days);

  return (
    <p className="mt-6 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-900">
      <span aria-hidden>🔥</span>
      {label}
      {next !== null ? (
        <span className="font-normal text-slate-500">
          · {next - days} to go for {next} days
        </span>
      ) : null}
    </p>
  );
}
