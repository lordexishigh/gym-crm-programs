/**
 * Membership plan shapes + input validation.
 *
 * A gym defines its own price list (monthly / annual / drop-in tiers); members
 * are attached to a plan via `member_plans`, which also carries the Stripe
 * correlation columns the checkout + webhook flow (lib/stripe.ts) writes.
 * Validation is a pure function so it can be unit-tested without a DB, same
 * pattern as lib/members.ts.
 *
 * Deliberately DB-free (no `@/lib/db` import): this module is imported at
 * runtime by client components (BillingPanel, MembershipStatus) for their
 * display helpers/types, and a client-bundled `pg` import breaks the Next.js
 * build (`fs`/`net`/`tls` have no browser shim). The DB-backed queries for
 * member billing/payment history live in `@/lib/billing` instead, imported
 * only from Server Components.
 */

export type PlanTier = "monthly" | "annual" | "drop_in";

export const PLAN_TIERS: PlanTier[] = ["monthly", "annual", "drop_in"];

export type MembershipPlanRow = {
  id: string;
  tenant_id: string;
  name: string;
  tier: PlanTier;
  price_cents: number;
  currency: string;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type PlanInput = {
  name: string;
  tier: PlanTier;
  priceCents: number;
  currency: string;
  active: boolean;
};

export type PlanValidationResult =
  | { ok: true; value: PlanInput }
  | { ok: false; error: string };

const NAME_MAX = 100;
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Validate + normalise raw plan form values.
 *
 * Rules:
 *   - name is required.
 *   - tier must be one of the fixed values (matches the CHECK constraint).
 *   - priceCents is a non-negative integer (whole cents — no fractional
 *     currency units), parsed from the form's decimal price input.
 *   - currency defaults to EUR (Cyprus gyms) and must be a 3-letter ISO code.
 */
export function validatePlanInput(raw: {
  name?: unknown;
  tier?: unknown;
  price?: unknown;
  currency?: unknown;
  active?: unknown;
}): PlanValidationResult {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return { ok: false, error: "Plan name is required." };
  if (name.length > NAME_MAX) {
    return { ok: false, error: `Plan name is too long (max ${NAME_MAX} characters).` };
  }

  const tier = typeof raw.tier === "string" ? raw.tier : "";
  if (!PLAN_TIERS.includes(tier as PlanTier)) {
    return { ok: false, error: "Choose a valid plan tier." };
  }

  const priceRaw = typeof raw.price === "string" ? raw.price.trim() : "";
  const priceNum = Number.parseFloat(priceRaw);
  if (!Number.isFinite(priceNum) || priceNum < 0) {
    return { ok: false, error: "Enter a valid, non-negative price." };
  }
  const priceCents = Math.round(priceNum * 100);

  const currencyRaw =
    typeof raw.currency === "string" && raw.currency.trim().length > 0
      ? raw.currency.trim().toUpperCase()
      : "EUR";
  if (!CURRENCY_RE.test(currencyRaw)) {
    return { ok: false, error: "Currency must be a 3-letter code (e.g. EUR)." };
  }

  const active = raw.active === undefined ? true : Boolean(raw.active);

  return {
    ok: true,
    value: { name, tier: tier as PlanTier, priceCents, currency: currencyRaw, active },
  };
}

/** Format cents as a display price string, e.g. 4999 → "49.99". */
export function formatPrice(priceCents: number): string {
  return (priceCents / 100).toFixed(2);
}

export const PLAN_TIER_LABELS: Record<PlanTier, string> = {
  monthly: "Monthly",
  annual: "Annual",
  drop_in: "Drop-in",
};

// ---------------------------------------------------------------------------
// Member subscription (member_plans).

export type MemberPlanStatus = "pending" | "active" | "past_due" | "cancelled";

export type MemberPlanRow = {
  id: string;
  tenant_id: string;
  member_id: string;
  plan_id: string;
  status: MemberPlanStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_payment_intent_id: string | null;
  payment_retry_count: number;
  current_period_end: string | null;
  started_at: string;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

/** A member's subscription joined with its plan, for display. */
export type MemberPlanWithPlan = MemberPlanRow & {
  plan_name: string;
  plan_tier: PlanTier;
  plan_price_cents: number;
  plan_currency: string;
};
