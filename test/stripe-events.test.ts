import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { extractPeriodEnd, extractSubscriptionId } from "../lib/stripe-events";

/**
 * Unit tests for the pure Stripe-invoice field extraction helpers used by the
 * webhook handler (lib/stripe-events.ts). Stripe has changed the invoice
 * shape across API versions (a plain `subscription` id vs. the newer
 * `parent.subscription_details.subscription`) — these guard both shapes so
 * the handler degrades gracefully rather than crashing on a shape mismatch.
 */
describe("extractSubscriptionId", () => {
  it("reads a string subscription id (older API shape)", () => {
    const invoice = { subscription: "sub_123" } as unknown as Stripe.Invoice;
    expect(extractSubscriptionId(invoice)).toBe("sub_123");
  });

  it("reads an expanded subscription object (older API shape)", () => {
    const invoice = { subscription: { id: "sub_456" } } as unknown as Stripe.Invoice;
    expect(extractSubscriptionId(invoice)).toBe("sub_456");
  });

  it("reads the newer parent.subscription_details shape", () => {
    const invoice = {
      parent: { subscription_details: { subscription: "sub_789" } },
    } as unknown as Stripe.Invoice;
    expect(extractSubscriptionId(invoice)).toBe("sub_789");
  });

  it("returns null for a one-time invoice with no subscription", () => {
    const invoice = {} as unknown as Stripe.Invoice;
    expect(extractSubscriptionId(invoice)).toBe(null);
  });
});

describe("extractPeriodEnd", () => {
  it("converts the first line item's period.end (unix seconds) to a Date", () => {
    const invoice = {
      lines: { data: [{ period: { end: 1_700_000_000 } }] },
    } as unknown as Stripe.Invoice;
    expect(extractPeriodEnd(invoice)?.getTime()).toBe(1_700_000_000 * 1000);
  });

  it("returns null when there are no line items", () => {
    const invoice = { lines: { data: [] } } as unknown as Stripe.Invoice;
    expect(extractPeriodEnd(invoice)).toBe(null);
  });
});
