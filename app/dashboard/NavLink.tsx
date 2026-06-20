"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Dashboard nav item with current-page awareness (beta-polish-a11y-001 +
 * beta-polish-a11y-002).
 *
 * - a11y: marks the active item with `aria-current="page"` so screen readers
 *   announce where the user is.
 * - UX: highlights the active section visually so staff always know which page
 *   they're on — a rough edge of the previous unstyled nav.
 *
 * Active match: the Overview link (`/dashboard`) matches only on an exact path;
 * section links also match their sub-routes (e.g. `/dashboard/members/new`).
 */
export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active =
    href === "/dashboard"
      ? pathname === href
      : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "rounded-md bg-brand/10 px-3 py-2 text-sm font-semibold text-brand"
          : "rounded-md px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
      }
    >
      {label}
    </Link>
  );
}
