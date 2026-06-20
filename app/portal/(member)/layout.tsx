import { requireMember } from "@/lib/auth/session";
import { logoutAction } from "@/lib/auth/actions";

// Session/identity is request-derived; never statically rendered.
export const dynamic = "force-dynamic";

/**
 * Member portal shell (mvp-auth-003). Mobile-first.
 *
 * Gated to member sessions via `requireMember` (redirects unauthenticated or
 * staff sessions). Routes under this group resolve to a single Member row + gym
 * tenant through RLS using the JWT-derived identity.
 */
export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireMember();

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
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

      <main className="flex-1 px-5 py-6">{children}</main>
    </div>
  );
}
