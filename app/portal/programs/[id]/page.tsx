import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMember } from "@/lib/auth/session";
import { logoutAction } from "@/lib/auth/actions";
import { loadMemberProgram } from "@/lib/portal";
import { ProgramView } from "../../ProgramView";

// Session/identity is request-derived; never statically rendered.
export const dynamic = "force-dynamic";

/**
 * Member portal program detail (alpha-program-lifecycle-002).
 *
 * Renders ONE program assigned to the signed-in member — active or archived —
 * strictly read-only, reusing `ProgramView`. This is the target of the "Past
 * programs" history links, but it also works for the current program.
 *
 * Member-scoped under RLS: `loadMemberProgram` returns null for any program not
 * assigned to this member (another member's or another gym's id is invisible by
 * construction), and we 404 rather than leaking its existence. The shell mirrors
 * the portal home (header + logout) with an added back link — kept inline here
 * for the same reason as the home page: an `app/portal/layout.tsx` would also
 * wrap the public login route and redirect-loop.
 */
export default async function PortalProgramPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireMember();
  const program = await loadMemberProgram(
    session.identity,
    session.identity.memberId as string,
    id,
  );
  if (!program) notFound();

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
        <Link
          href="/portal"
          className="mb-4 inline-block text-sm font-medium text-slate-500 transition hover:text-slate-700"
        >
          ← Back
        </Link>
        <ProgramView programs={[program]} />
      </main>
    </div>
  );
}
