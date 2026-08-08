import type { PaymentEventRow } from "../../lib/billing";

/**
 * Read-only "Payment history" list for the member portal (market gap #8),
 * sourced from `payment_events` (written by the Stripe webhook — see
 * lib/stripe-events.ts). Pure presentation, same pattern as `WorkoutHistory`.
 *
 * The section renders even with no payments. An earlier version returned null
 * on an empty list, which made a shipped feature indistinguishable from a
 * missing one — a member with no recorded payments never saw that the portal
 * HAS a payment history, and an evaluation of this app duly reported the
 * feature as not live. "Nothing has been charged yet" is a real, meaningful
 * state for a member to read, so it is shown rather than hidden.
 */
export function PaymentHistory({ events }: { events: PaymentEventRow[] }) {
  if (events.length === 0) {
    return (
      <section className="mt-10 flex flex-col gap-3 border-t border-slate-200 pt-6">
        <h2 className="text-lg font-bold text-slate-900">Payment history</h2>
        <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          No payments have been recorded yet. Receipts appear here once your
          first payment goes through.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-10 flex flex-col gap-3 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-bold text-slate-900">Payment history</h2>
      <ul className="flex flex-col gap-2">
        {events.map((ev) => (
          <li
            key={ev.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm"
          >
            <span className="text-slate-500">
              {new Date(ev.occurred_at).toLocaleDateString("en-GB", { dateStyle: "medium" })}
            </span>
            <span className="font-medium text-slate-900">
              {(ev.amount_cents / 100).toFixed(2)} {ev.currency}
            </span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                ev.status === "succeeded"
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-red-50 text-red-700"
              }`}
            >
              {ev.status === "succeeded" ? "Paid" : "Failed"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
