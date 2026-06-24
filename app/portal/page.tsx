import { requireMember } from "@/lib/auth/session";
import { logoutAction } from "@/lib/auth/actions";
import { archivedPrograms, loadMemberPortal } from "@/lib/portal";
import { recentWorkoutLogs } from "@/lib/workout-logs";
import { ProgramView } from "./ProgramView";
import { ProgramHistory } from "./ProgramHistory";
import { LogWorkout } from "./LogWorkout";
import { WorkoutHistory } from "./WorkoutHistory";

// Session/identity is request-derived; never statically rendered.
export const dynamic = "force-dynamic";

/**
 * Member portal home (mvp-member-portal-001/002).
 *
 * Resolves the signed-in member's OWN assigned program(s) and renders them as a
 * strictly read-only, mobile-first view (see `ProgramView`). The member-scoped
 * query lives in `@/lib/portal` so the page and its isolation test share one
 * definition. Isolation is enforced by RLS — under a member session the
 * `assignment_member_select`, `program_member_select`, and
 * `exercise_member_select` policies (migration 0002) make rows belonging to
 * other members or gyms invisible by construction, so a crafted request cannot
 * widen the result. We pass the server-verified `memberId` from the session
 * (never a client-supplied id); the explicit filter is belt-and-suspenders.
 *
 * The member shell (header + logout) is rendered inline here rather than in a
 * route layout: the portal login page lives under the same `app/portal` segment,
 * so an `app/portal/layout.tsx` that called `requireMember` would also wrap
 * login and redirect-loop. Gating happens in this page; login stays public.
 */
export default async function PortalPage() {
  const session = await requireMember();
  const memberId = session.identity.memberId as string;
  // Active program (shown by default), the read-only history of past programs,
  // and the member's recent logged workout sessions (Phase GA).
  const [programs, history, workouts] = await Promise.all([
    loadMemberPortal(session.identity, memberId),
    archivedPrograms(session.identity, memberId),
    recentWorkoutLogs(session.identity, memberId),
  ]);

  // The active programs a member can log a session against (id + name only).
  const activePrograms = programs.map(({ program }) => ({
    id: program.id,
    name: program.name,
  }));

  // Mobile-first shell: full-width on a phone, capped/centred on larger screens.
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col">
      {/* Keyboard skip-link: first tab stop jumps past the header to the program. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-brand focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white shadow-sm"
          >
            A
          </span>
          <span className="text-base font-bold tracking-tight text-brand">
            Alpha CRM
          </span>
        </span>
        <form action={logoutAction}>
          <input type="hidden" name="redirectTo" value="/portal/login" />
          <button
            type="submit"
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
          >
            Log out
          </button>
        </form>
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className="flex-1 px-4 py-6 focus:outline-none sm:px-6 sm:py-8"
      >
        <ProgramView programs={programs} />
        <LogWorkout programs={activePrograms} />
        <WorkoutHistory logs={workouts} />
        <ProgramHistory programs={history} />
      </main>
    </div>
  );
}
