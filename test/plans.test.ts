import { describe, expect, it } from "vitest";
import { formatPrice, validatePlanInput } from "../lib/plans";

describe("validatePlanInput", () => {
  it("accepts a valid monthly plan and converts price to cents", () => {
    const r = validatePlanInput({ name: "Unlimited", tier: "monthly", price: "49.99" });
    expect(r).toEqual({
      ok: true,
      value: { name: "Unlimited", tier: "monthly", priceCents: 4999, currency: "EUR", active: true },
    });
  });

  it("rejects a missing name", () => {
    expect(validatePlanInput({ tier: "monthly", price: "10" }).ok).toBe(false);
  });

  it("rejects an invalid tier", () => {
    expect(
      validatePlanInput({ name: "X", tier: "weekly", price: "10" }).ok,
    ).toBe(false);
  });

  it("rejects a negative or non-numeric price", () => {
    expect(validatePlanInput({ name: "X", tier: "monthly", price: "-5" }).ok).toBe(false);
    expect(validatePlanInput({ name: "X", tier: "monthly", price: "abc" }).ok).toBe(false);
  });

  it("accepts a drop_in tier with a zero price", () => {
    const r = validatePlanInput({ name: "Free trial", tier: "drop_in", price: "0" });
    expect(r.ok && r.value.priceCents).toBe(0);
  });

  it("defaults currency to EUR and validates a custom one", () => {
    const r = validatePlanInput({ name: "X", tier: "annual", price: "500" });
    expect(r.ok && r.value.currency).toBe("EUR");
    const gbp = validatePlanInput({ name: "X", tier: "annual", price: "500", currency: "gbp" });
    expect(gbp.ok && gbp.value.currency).toBe("GBP");
    expect(
      validatePlanInput({ name: "X", tier: "annual", price: "500", currency: "€" }).ok,
    ).toBe(false);
  });
});

describe("formatPrice", () => {
  it("formats cents as a two-decimal price", () => {
    expect(formatPrice(4999)).toBe("49.99");
    expect(formatPrice(0)).toBe("0.00");
    expect(formatPrice(500000)).toBe("5000.00");
  });
});
