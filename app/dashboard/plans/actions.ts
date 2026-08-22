"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import { hasCapability } from "@/lib/capabilities";
import { PAYMENTS_UNCONFIGURED_MESSAGE, validatePlanInput } from "@/lib/plans";
import { createCheckoutSession } from "@/lib/stripe";
import { reportHandledError } from "@/lib/observability/monitoring";

/**
 * Owner-only membership plan mutations. Gated by `requireOwner` (server-side
 * role check) — a trainer can't create/edit plans or see pricing here even by
 * guessing the URL, since RLS's `membership_plans_staff_all` policy only gates
 * the tenant, not the owner/trainer split (that split has no DB representation
 * to enforce with RLS, so it must be enforced in the action itself).
 */

export type PlanFormState = { error?: string; success?: string };

export async function createPlanAction(
  _prev: PlanFormState,
  formData: FormData,
): Promise<PlanFormState> {
  const session = await requireOwner();

  const parsed = validatePlanInput({
    name: formData.get("name"),
    tier: formData.get("tier"),
    price: formData.get("price"),
    currency: formData.get("currency"),
  });
  if (!parsed.ok) return { error: parsed.error };
  const { name, tier, priceCents, currency } = parsed.value;

  try {
    await withTenantContext(session.identity, async (c) => {
      await c.query(
        `insert into membership_plans (tenant_id, name, tier, price_cents, currency)
         values ($1, $2, $3, $4, $5)`,
        [session.identity.tenantId, name, tier, priceCents, currency],
      );
    });
  } catch (err) {
    await reportHandledError(err, "create-plan", { tenantId: session.identity.tenantId });
    return { error: "Could not save the plan. Please try again." };
  }

  revalidatePath("/dashboard/plans");
  return { success: `Added “${name}”.` };
}

/** Toggle a plan active/inactive (soft "archive" — never deleted, keeps FK history). */
export async function togglePlanActiveAction(formData: FormData): Promise<void> {
  const session = await requireOwner();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await withTenantContext(session.identity, async (c) => {
    await c.query(
      "update membership_plans set active = not active, updated_at = now() where id = $1",
      [id],
    );
  });

  revalidatePath("/dashboard/plans");
}

export type AssignPlanState = { error?: string; success?: string };

/** Attach a member to a plan (creates a `pending` subscription row, checked out via Stripe). */
export async function assignPlanAction(
  _prev: AssignPlanState,
  formData: FormData,
): Promise<AssignPlanState> {
  const session = await requireOwner();

  const memberId = String(formData.get("memberId") ?? "");
  const planId = String(formData.get("planId") ?? "");
  if (!memberId || !planId) return { error: "Missing member or plan." };

  try {
    await withTenantContext(session.identity, async (c) => {
      await c.query(
        `insert into member_plans (tenant_id, member_id, plan_id, status)
         values ($1, $2, $3, 'pending')`,
        [session.identity.tenantId, memberId, planId],
      );
    });
  } catch (err) {
    await reportHandledError(err, "assign-plan", {
      tenantId: session.identity.tenantId,
      memberId,
      planId,
    });
    return { error: "Could not assign the plan. Please try again." };
  }

  revalidatePath(`/dashboard/members/${memberId}`);
  // Don't tell the owner to send a checkout link on a deployment that cannot
  // create one — that instruction is what makes an unconfigured integration read
  // as a broken one.
  return {
    success: hasCapability("payments")
      ? "Plan assigned. Send the member a checkout link to collect payment."
      : "Plan assigned. It stays 'pending' until a payment is recorded, and Stripe " +
        "is not configured on this deployment — collect payment by hand for now.",
  };
}

export type CheckoutState = { error?: string };

/**
 * Create a Stripe Checkout Session for an existing member_plans row and
 * redirect the browser there. Loads the plan + member email under RLS (so a
 * cross-tenant id 404s rather than leaking another gym's pricing to Stripe),
 * then hands off to Stripe-hosted checkout — no card data ever touches our
 * server.
 */
export async function createCheckoutSessionAction(
  _prev: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  const session = await requireOwner();
  const memberPlanId = String(formData.get("memberPlanId") ?? "");
  if (!memberPlanId) return { error: "Missing subscription." };

  // Checked before the query and before Stripe: an unconfigured deployment is a
  // known, permanent state, not a fault. Falling through would have loaded the
  // subscription, called `getStripeClient()`, thrown "STRIPE_SECRET_KEY is not
  // set", reported it to monitoring as a handled ERROR, and told the owner to
  // "try again" — noise in the logs and a lie on the screen. BillingPanel
  // already hides the button in this state; this covers the paths that bypass a
  // fresh render (a stale tab, a replayed post).
  if (!hasCapability("payments")) {
    return { error: PAYMENTS_UNCONFIGURED_MESSAGE };
  }

  type Row = {
    id: string;
    member_id: string;
    plan_name: string;
    tier: "monthly" | "annual" | "drop_in";
    price_cents: number;
    currency: string;
    member_email: string | null;
  };

  let row: Row | null;
  try {
    row = await withTenantContext(session.identity, async (c) => {
      const { rows } = await c.query<Row>(
        `select mp.id, mp.member_id, p.name as plan_name, p.tier, p.price_cents,
                p.currency, m.email as member_email
           from member_plans mp
           join membership_plans p on p.id = mp.plan_id
           join member m on m.id = mp.member_id
          where mp.id = $1`,
        [memberPlanId],
      );
      return rows[0] ?? null;
    });
  } catch (err) {
    await reportHandledError(err, "create-checkout-session-load", {
      tenantId: session.identity.tenantId,
      memberPlanId,
    });
    return { error: "Could not load this subscription. Please try again." };
  }

  if (!row) return { error: "Subscription not found." };
  if (!row.member_email) {
    return { error: "This member has no email address — add one before checking out." };
  }

  const base = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  let checkoutUrl: string | null;
  try {
    const checkoutSession = await createCheckoutSession({
      memberPlanId: row.id,
      planName: row.plan_name,
      tier: row.tier,
      priceCents: row.price_cents,
      currency: row.currency,
      memberEmail: row.member_email,
      tenantId: session.identity.tenantId,
      memberId: row.member_id,
      successUrl: `${base}/dashboard/members/${row.member_id}?checkout=success`,
      cancelUrl: `${base}/dashboard/members/${row.member_id}?checkout=cancelled`,
    });
    checkoutUrl = checkoutSession.url;
  } catch (err) {
    await reportHandledError(err, "create-checkout-session", {
      tenantId: session.identity.tenantId,
      memberPlanId,
    });
    return { error: "Could not start checkout. Please try again." };
  }

  if (!checkoutUrl) return { error: "Stripe did not return a checkout link." };
  redirect(checkoutUrl);
}
