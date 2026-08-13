/**
 * Current-streak badge for the member portal (CRM-IDEAS "Next" #7 —
 * engagement layer: streaks & badges, scoped to the streak itself).
 *
 * Pure presentation: takes the already-computed streak length as a prop, so it
 * is unit-testable without a session or database, mirroring `WorkoutHistory` /
 * `ProgramHistory`. Renders nothing at 0 (no streak to show yet) so it never
 * displaces the "Log a workout" empty-state invitation.
 */
export function StreakBadge({ days }: { days: number }) {
  if (days <= 0) return null;

  return (
    <p className="mt-6 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-900">
      <span aria-hidden>🔥</span>
      {days === 1 ? "1 day streak" : `${days} day streak`}
    </p>
  );
}
