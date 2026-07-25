import Link from "next/link";
import { requireStaff } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import { logoutAction } from "@/lib/auth/actions";
import { getStaffRole } from "@/lib/staff";
import { NavLink } from "./NavLink";

// Session/identity is request-derived; never statically rendered.
export const dynamic = "force-dynamic";

/**
 * Authenticated staff dashboard shell (mvp-auth-002).
 *
 * Gated to staff via `requireStaff` (redirects unauthenticated/member sessions).
 * The gym name is resolved through `withTenantContext` so RLS confirms the
 * session resolves to exactly one tenant — the staff member's own gym.
 */
const BASE_NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/members", label: "Members" },
  { href: "/dashboard/invites", label: "Invites" },
  { href: "/dashboard/classes", label: "Classes" },
  { href: "/dashboard/checkin", label: "Check-in" },
  { href: "/dashboard/programs", label: "Programs" },
  { href: "/dashboard/exercises", label: "Exercises" },
  { href: "/dashboard/templates", label: "Templates" },
];

// Owner-only: billing/revenue data, hidden from trainers server-side (the nav
// is cosmetic — the actual gate is `requireOwner` on the /plans route itself).
const OWNER_NAV = [{ href: "/dashboard/plans", label: "Plans" }];

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireStaff();

  // Resolve the tenant name + owner/trainer role under RLS in one round trip.
  const { gymName, staffRole } = await withTenantContext(session.identity, async (c) => {
    const gym = await c.query<{ name: string }>(
      "select name from gym where id = $1",
      [session.identity.tenantId],
    );
    const role = session.identity.userId
      ? await c.query<{ role: "owner" | "trainer" }>(
          "select role from users where auth_user_id = $1",
          [session.identity.userId],
        )
      : { rows: [] };
    return {
      gymName: gym.rows[0]?.name ?? "Your gym",
      staffRole: role.rows[0]?.role ?? "trainer",
    };
  });

  const NAV = staffRole === "owner" ? [...BASE_NAV, ...OWNER_NAV] : BASE_NAV;

  return (
    <div className="flex min-h-screen flex-col">
      {/* Keyboard skip-link: first tab stop jumps past the nav to the content. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-brand focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/dashboard" className="flex items-center gap-2.5">
              <span
                aria-hidden
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white shadow-sm"
              >
                A
              </span>
              <span className="text-base font-bold tracking-tight text-brand">
                Alpha CRM
              </span>
            </Link>
            <span className="hidden truncate text-sm text-slate-500 sm:inline">
              · {gymName}
            </span>
          </div>
          <form action={logoutAction}>
            <input type="hidden" name="redirectTo" value="/login" />
            <button
              type="submit"
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 hover:text-slate-900"
            >
              Log out
            </button>
          </form>
        </div>
        <nav
          aria-label="Primary"
          className="mx-auto flex w-full max-w-5xl gap-1 overflow-x-auto px-3 pb-2"
        >
          {NAV.map((item) => (
            <NavLink key={item.href} href={item.href} label={item.label} />
          ))}
        </nav>
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-5xl flex-1 px-5 py-6 focus:outline-none"
      >
        {children}
      </main>
    </div>
  );
}
