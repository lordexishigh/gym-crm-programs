import { requireMember } from "@/lib/auth/session";
import { logoutAction } from "@/lib/auth/actions";
import { archivedPrograms, loadMemberPortal } from "@/lib/portal";
import { ProgramView } from "./ProgramView";
import { ProgramHistory } from "./ProgramHistory";

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
  // Active program (shown by default) + the read-only history of past programs.
  const [programs, history] = await Promise.all([
    loadMemberPortal(session.identity, memberId),
    archivedPrograms(session.identity, memberId),
  ]);

  // Mobile-first shell: full-width on a phone, capped/centred on larger screens.
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-6">
        <span className="text-base font-bold text-brand">Alpha CRM</span>
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

      <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <ProgramView programs={programs} />
        <ProgramHistory programs={history} />
      </main>
    </div>
  );
}
