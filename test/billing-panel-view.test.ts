import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BillingPanel } from "../app/dashboard/members/[id]/BillingPanel";
import type { MemberPlanWithPlan, MembershipPlanRow } from "../lib/plans";

/**
 * Owner billing panel VIEW tests — pure presentation, no session or database,
 * mirroring `invite-list-view` / `program-authoring-view`.
 *
 * What these guard: production has no `STRIPE_SECRET_KEY` (verified 2026-08-20
 * on the live Vercel project), and the panel used to offer "Send checkout link"
 * regardless. Pressing it reached `getStripeClient()`, threw, and answered
 * "Could not start checkout. Please try again." — so the Stripe integration read
 * as BROKEN rather than unconfigured, which is how it kept being reported as
 * "built but the running app doesn't serve it". A control that cannot work must
 * not be offered, and the reason has to be on screen.
 */

const PLAN: MembershipPlanRow = {
  id: "plan-1",
  tenant_id: "tenant-1",
  name: "Monthly Unlimited",
  tier: "monthly",
  price_cents: 4500,
  currency: "EUR",
  active: true,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

function subscription(status: MemberPlanWithPlan["status"]): MemberPlanWithPlan {
  return {
    id: "member-plan-1",
    tenant_id: "tenant-1",
    member_id: "member-1",
    plan_id: PLAN.id,
    status,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    stripe_payment_intent_id: null,
    payment_retry_count: 0,
    current_period_end: null,
    started_at: "2026-08-01T00:00:00.000Z",
    cancelled_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    plan_name: PLAN.name,
    plan_tier: PLAN.tier,
    plan_price_cents: PLAN.price_cents,
    plan_currency: PLAN.currency,
  };
}

function render(opts: {
  paymentsConfigured: boolean;
  subscriptions?: MemberPlanWithPlan[];
}): string {
  return renderToStaticMarkup(
    createElement(BillingPanel, {
      memberId: "member-1",
      plans: [PLAN],
      subscriptions: opts.subscriptions ?? [subscription("pending")],
      paymentsConfigured: opts.paymentsConfigured,
    }),
  );
}

describe("BillingPanel with Stripe configured", () => {
  it("offers a checkout link for a subscription awaiting payment", () => {
    const html = render({ paymentsConfigured: true });
    expect(html).toContain("Send checkout link");
    expect(html).toContain("collect payment via a Stripe checkout link");
  });

  it("offers a checkout link for a past-due subscription (the retry path)", () => {
    const html = render({
      paymentsConfigured: true,
      subscriptions: [subscription("past_due")],
    });
    expect(html).toContain("Send checkout link");
  });

  it("does not offer one for a subscription that is already paid", () => {
    const html = render({
      paymentsConfigured: true,
      subscriptions: [subscription("active")],
    });
    expect(html).not.toContain("Send checkout link");
  });

  it("says nothing about configuration when there is nothing to report", () => {
    const html = render({ paymentsConfigured: true });
    expect(html).not.toContain("Stripe is not configured");
  });
});

describe("BillingPanel with Stripe unconfigured", () => {
  it("withholds the checkout button rather than failing on submit", () => {
    const html = render({ paymentsConfigured: false });
    expect(html).not.toContain("Send checkout link");
  });

  it("states the gap, the variables to set, and what still works", () => {
    const html = render({ paymentsConfigured: false });
    expect(html).toContain("Stripe is not configured on this deployment");
    expect(html).toContain("STRIPE_SECRET_KEY");
    expect(html).toContain("STRIPE_WEBHOOK_SECRET");
    expect(html).toContain("tracked by hand");
  });

  it("announces the gap politely — a standing condition, not an event", () => {
    // Same reasoning as CapabilityNotice: role="status", never role="alert".
    const html = render({ paymentsConfigured: false });
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });

  it("does not promise a checkout link in the panel's own description", () => {
    const html = render({ paymentsConfigured: false });
    expect(html).not.toContain("collect payment via a Stripe checkout link");
    expect(html).toContain("collects payment outside the app");
  });

  it("still assigns plans — the half that works without Stripe", () => {
    const html = render({ paymentsConfigured: false });
    expect(html).toContain("Assign plan");
    expect(html).toContain("Monthly Unlimited");
  });

  it("still shows the failed-payment retry count it has on record", () => {
    // The retry counter is written by the webhook, so it stays meaningful for a
    // deployment that WAS configured and no longer is.
    const html = render({
      paymentsConfigured: false,
      subscriptions: [{ ...subscription("past_due"), payment_retry_count: 2 }],
    });
    expect(html).toContain("2 failed payment retries");
  });
});
