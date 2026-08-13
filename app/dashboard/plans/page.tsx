import { requireOwner } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import {
  formatPrice,
  PLAN_TIER_LABELS,
  type MembershipPlanRow,
} from "@/lib/plans";
import { AddPlanButton } from "./AddPlanButton";
import { togglePlanActiveAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Owner-only membership plan management (market gap #2). Gated by
 * `requireOwner` — a trainer session is redirected to the dashboard overview
 * before any pricing data is queried.
 */
export default async function PlansPage() {
  const session = await requireOwner();

  const plans = await withTenantContext(session.identity, async (c) => {
    const { rows } = await c.query<MembershipPlanRow>(
      `select id, tenant_id, name, tier, price_cents, currency, active,
              created_at, updated_at
         from membership_plans
        order by active desc, tier, price_cents`,
    );
    return rows;
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold">Membership plans</h1>
          <p className="text-sm text-slate-600">
            Pricing tiers members can be billed against. Owner-only — trainers
            do not see revenue data.
          </p>
        </div>
        <AddPlanButton />
      </div>

      {plans.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          No plans yet. Use “Add plan” to create your first pricing tier.
        </div>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {plans.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-medium text-slate-900">{p.name}</span>
                <span className="text-sm text-slate-500">
                  {PLAN_TIER_LABELS[p.tier]} · {formatPrice(p.price_cents)} {p.currency}
                  {p.tier === "monthly" ? " / month" : p.tier === "annual" ? " / year" : ""}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span
                  className={
                    p.active
                      ? "rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"
                      : "rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600"
                  }
                >
                  {p.active ? "Active" : "Archived"}
                </span>
                <form action={togglePlanActiveAction}>
                  <input type="hidden" name="id" value={p.id} />
                  <button
                    type="submit"
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                  >
                    {p.active ? "Archive" : "Reactivate"}
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
