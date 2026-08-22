"use client";

import { useActionState } from "react";
import {
  formatPrice,
  PAYMENTS_UNCONFIGURED_MESSAGE,
  PLAN_TIER_LABELS,
  type MemberPlanWithPlan,
  type MembershipPlanRow,
} from "@/lib/plans";
import {
  assignPlanAction,
  createCheckoutSessionAction,
  type AssignPlanState,
  type CheckoutState,
} from "../../plans/actions";

const initialState: AssignPlanState = {};

const STATUS_STYLES: Record<MemberPlanWithPlan["status"], string> = {
  pending: "bg-slate-100 text-slate-600",
  active: "bg-emerald-50 text-emerald-700",
  past_due: "bg-amber-50 text-amber-700",
  cancelled: "bg-red-50 text-red-700",
};

/**
 * Owner-only billing panel on the member detail page (market gaps #2/#3):
 * assign a plan and see the member's subscription history, including the
 * failed-payment retry count the Stripe webhook increments.
 *
 * `paymentsConfigured` comes from `hasCapability("payments")` on the server —
 * env vars are not readable in a client component, and the alternative (offer
 * the button, discover on submit) is what made the deployment look broken: see
 * PAYMENTS_UNCONFIGURED_MESSAGE.
 */
export function BillingPanel({
  memberId,
  plans,
  subscriptions,
  paymentsConfigured,
}: {
  memberId: string;
  plans: MembershipPlanRow[];
  subscriptions: MemberPlanWithPlan[];
  paymentsConfigured: boolean;
}) {
  const [state, formAction, pending] = useActionState(assignPlanAction, initialState);

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-slate-900">Billing</h2>
        <p className="text-sm text-slate-500">
          {paymentsConfigured
            ? "Owner-only. Assign a plan, then collect payment via a Stripe checkout link."
            : "Owner-only. Assign a plan and track it here — this deployment collects payment outside the app."}
        </p>
      </div>

      {/* A standing condition of the deployment, stated once at the top of the
          panel rather than only when a button is pressed. `role="status"` for
          the same reason as CapabilityNotice: it is not an event. */}
      {!paymentsConfigured ? (
        <p
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {PAYMENTS_UNCONFIGURED_MESSAGE}
        </p>
      ) : null}

      {subscriptions.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {subscriptions.map((sub) => (
            <li
              key={sub.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm"
            >
              <div className="flex min-w-0 flex-col">
                <span className="font-medium text-slate-900">
                  {sub.plan_name}{" "}
                  <span className="font-normal text-slate-500">
                    ({PLAN_TIER_LABELS[sub.plan_tier]} · {formatPrice(sub.plan_price_cents)}{" "}
                    {sub.plan_currency})
                  </span>
                </span>
                {sub.current_period_end ? (
                  <span className="text-xs text-slate-500">
                    Renews {new Date(sub.current_period_end).toLocaleDateString()}
                  </span>
                ) : null}
                {sub.payment_retry_count > 0 ? (
                  <span className="text-xs font-medium text-amber-700">
                    {sub.payment_retry_count} failed payment retr
                    {sub.payment_retry_count === 1 ? "y" : "ies"}
                  </span>
                ) : null}
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[sub.status]}`}
              >
                {sub.status.replace("_", " ")}
              </span>
              {(sub.status === "pending" || sub.status === "past_due") &&
              paymentsConfigured ? (
                <CheckoutButton memberPlanId={sub.id} />
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-500">No plan assigned yet.</p>
      )}

      {plans.length === 0 ? (
        <p className="text-sm text-slate-500">
          No active plans to assign —{" "}
          <a href="/dashboard/plans" className="font-medium text-brand hover:text-brand-dark">
            create one first
          </a>
          .
        </p>
      ) : (
        <form action={formAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="memberId" value={memberId} />
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Assign plan
            <select
              name="planId"
              required
              className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            >
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {formatPrice(p.price_cents)} {p.currency}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-dark disabled:opacity-60"
          >
            {pending ? "Assigning…" : "Assign"}
          </button>
        </form>
      )}

      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
      {state.success ? <p className="text-sm text-emerald-700">{state.success}</p> : null}
    </section>
  );
}

const checkoutInitialState: CheckoutState = {};

/** Kicks off a Stripe Checkout Session for one subscription row. */
function CheckoutButton({ memberPlanId }: { memberPlanId: string }) {
  const [state, formAction, pending] = useActionState(
    createCheckoutSessionAction,
    checkoutInitialState,
  );

  return (
    <form action={formAction} className="flex shrink-0 flex-col items-end gap-1">
      <input type="hidden" name="memberPlanId" value={memberPlanId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
      >
        {pending ? "Starting…" : "Send checkout link"}
      </button>
      {state.error ? <p className="text-xs text-red-600">{state.error}</p> : null}
    </form>
  );
}
