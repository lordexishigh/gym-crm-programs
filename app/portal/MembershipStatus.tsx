import { formatPrice, PLAN_TIER_LABELS, type MemberPlanWithPlan } from "../../lib/plans";

const STATUS_LABELS: Record<"active" | "expired" | "frozen" | "cancelled", string> = {
  active: "Active",
  expired: "Expired",
  frozen: "Frozen",
  cancelled: "Cancelled",
};

const STATUS_STYLES: Record<"active" | "expired" | "frozen" | "cancelled", string> = {
  active: "bg-emerald-50 text-emerald-700",
  expired: "bg-red-50 text-red-700",
  frozen: "bg-amber-50 text-amber-700",
  cancelled: "bg-slate-100 text-slate-600",
};

/**
 * Read-only "Membership" card for the member portal (market gap #8): the
 * billing-lifecycle status plus the member's current plan, so a member can see
 * what they owe and when it renews without contacting the front desk.
 *
 * Pure presentation — takes already-resolved data as props, same pattern as
 * `WorkoutHistory` — so it renders in a test without a session or database.
 */
export function MembershipStatus({
  membershipStatus,
  plans,
}: {
  membershipStatus: "active" | "expired" | "frozen" | "cancelled" | null;
  plans: MemberPlanWithPlan[];
}) {
  const current = plans.find((p) => p.status === "active" || p.status === "past_due");

  return (
    <section className="mt-10 flex flex-col gap-3 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-bold text-slate-900">Membership</h2>
      <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-slate-900">Status</span>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              membershipStatus ? STATUS_STYLES[membershipStatus] : "bg-slate-100 text-slate-600"
            }`}
          >
            {membershipStatus ? STATUS_LABELS[membershipStatus] : "Unknown"}
          </span>
        </div>
        {current ? (
          <div className="flex flex-col gap-1 border-t border-slate-100 pt-2 text-sm">
            <span className="font-medium text-slate-900">
              {current.plan_name}{" "}
              <span className="font-normal text-slate-500">
                ({PLAN_TIER_LABELS[current.plan_tier]} ·{" "}
                {formatPrice(current.plan_price_cents)} {current.plan_currency})
              </span>
            </span>
            {current.current_period_end ? (
              <span className="text-xs text-slate-500">
                Renews {new Date(current.current_period_end).toLocaleDateString()}
              </span>
            ) : null}
            {current.status === "past_due" ? (
              <span className="text-xs font-medium text-amber-700">
                Your last payment didn&apos;t go through — we&apos;ll keep retrying automatically.
              </span>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-slate-500">No active plan on file yet.</p>
        )}
      </div>
    </section>
  );
}
