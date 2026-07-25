import { withTenantContext, type Identity } from "@/lib/db";
import type { MemberPlanWithPlan } from "@/lib/plans";

/**
 * Member billing/payment-history reads (market gap #8): the DB-backed half of
 * `lib/plans.ts`, split out so `lib/plans.ts` stays free of `@/lib/db` — that
 * module is imported at runtime by client components (BillingPanel,
 * MembershipStatus) for their display helpers/types, and bundling `pg` into a
 * client component breaks the Next.js build (`fs`/`net`/`tls` have no browser
 * shim). This module is imported only from Server Components/Server Actions.
 */

// Shared read query — kept in one place so the staff billing panel and the
// member portal cannot drift on the join.
const MEMBER_PLANS_SQL = `select mp.id, mp.tenant_id, mp.member_id, mp.plan_id, mp.status,
        mp.stripe_customer_id, mp.stripe_subscription_id, mp.stripe_payment_intent_id,
        mp.payment_retry_count, mp.current_period_end, mp.started_at, mp.cancelled_at,
        mp.created_at, mp.updated_at,
        p.name as plan_name, p.tier as plan_tier, p.price_cents as plan_price_cents,
        p.currency as plan_currency
   from member_plans mp
   join membership_plans p on p.id = mp.plan_id
  where mp.member_id = $1
  order by mp.started_at desc`;

/**
 * A member's subscription history + current plan(s), joined with plan details
 * for display. Used by BOTH the staff billing panel and the member portal's
 * own "membership status" section — secured by RLS, not by this query:
 * `member_plans_staff_all` scopes staff to their own gym, `member_plans_self_select`
 * scopes a member session to their own rows, so a crafted `memberId` returns
 * nothing under a member session.
 */
export async function memberPlansFor(
  identity: Identity,
  memberId: string,
): Promise<MemberPlanWithPlan[]> {
  return withTenantContext(
    identity,
    async (c) => (await c.query<MemberPlanWithPlan>(MEMBER_PLANS_SQL, [memberId])).rows,
  );
}

/**
 * The signed-in member's own billing-lifecycle status (market gap #8) — the
 * `member.membership_status` column, distinct from the roster `status` flag
 * (see migration 0013). `member_self_select` (migration 0002) scopes this to
 * the caller's own row under a member session.
 */
export async function memberMembershipStatus(
  identity: Identity,
  memberId: string,
): Promise<"active" | "expired" | "frozen" | "cancelled" | null> {
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<{
      membership_status: "active" | "expired" | "frozen" | "cancelled";
    }>("select membership_status from member where id = $1", [memberId]);
    return rows[0]?.membership_status ?? null;
  });
}

/** A single payment event, for the member portal's payment-history list. */
export type PaymentEventRow = {
  id: string;
  amount_cents: number;
  currency: string;
  status: "succeeded" | "failed";
  occurred_at: string;
};

/** How many recent payment events the portal surfaces by default. */
export const PAYMENT_HISTORY_LIMIT = 20;

/**
 * The member's own payment history (market gap #8), most recent first.
 * `payment_events_self_select` (migration 0017) scopes this to the caller's
 * own rows under a member session; a staff session sees the whole tenant's
 * history for the given member via `payment_events_staff_all`.
 */
export async function paymentHistoryForMember(
  identity: Identity,
  memberId: string,
  limit: number = PAYMENT_HISTORY_LIMIT,
): Promise<PaymentEventRow[]> {
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<PaymentEventRow>(
      `select id, amount_cents, currency, status, occurred_at
         from payment_events
        where member_id = $1
        order by occurred_at desc
        limit $2`,
      [memberId, limit],
    );
    return rows;
  });
}
