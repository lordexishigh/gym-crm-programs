import { withTenantContext, type Identity } from "@/lib/db";
import { resolveActorUserId } from "@/lib/gdpr/audit";

/**
 * Off-card payment logging and revenue reconciliation (docs/EDGE.md
 * differentiator #3, migration 0026).
 *
 * Mirrors lib/classes.ts / lib/programs.ts: a pure `validate*Input` with no DB
 * and no env, unit-testable on a machine with no Postgres, and DB access via
 * `withTenantContext` so RLS is the boundary rather than these functions.
 *
 * WHY MONEY IS INTEGER CENTS EVERYWHERE HERE. `payment_events.amount_cents`
 * (0017) is already an integer, and the reconciliation view sums the two tables
 * together. Parsing "45.50" to a float anywhere in that path reintroduces the
 * rounding error the schema avoided — and a revenue figure that disagrees with
 * the bank by a cent is exactly the loss of trust this feature exists to fix.
 * So the string is parsed to cents once, here, and never becomes a float.
 *
 * DO NOT IMPORT THIS FROM A `"use client"` COMPONENT. It reaches `lib/db`, which
 * pulls `pg` into the client bundle. The convention here (see lib/classes.ts and
 * its forms) is that client components receive already-fetched plain props and
 * never import the domain module — `formatCents` is called on the server and the
 * formatted string handed over. `lib/demo-accounts.ts` documents the same
 * constraint from the other direction.
 */

/** How the money actually arrived. Matches 0026's CHECK constraint. */
export const PAYMENT_METHODS = ["cash", "bank_transfer", "sepa", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Human labels for the form and the CSV. */
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  sepa: "SEPA transfer",
  other: "Other",
};

export type ManualPaymentRow = {
  id: string;
  tenant_id: string;
  member_id: string;
  amount_cents: number;
  currency: string;
  method: PaymentMethod;
  reference: string | null;
  note: string | null;
  received_on: string;
  entered_by: string | null;
  entered_by_name: string | null;
  voided_at: string | null;
  voided_by_name: string | null;
  void_reason: string | null;
  created_at: string;
};

export type ManualPaymentInput = {
  amountCents: number;
  currency: string;
  method: PaymentMethod;
  reference: string | null;
  note: string | null;
  receivedOn: string;
};

export type ManualPaymentValidationResult =
  | { ok: true; value: ManualPaymentInput }
  | { ok: false; error: string };

const REFERENCE_MAX = 140;
const NOTE_MAX = 500;
/** €1,000,000 in cents. A gym membership is never this; a typo often is. */
const AMOUNT_CENTS_MAX = 100_000_000;

/**
 * Parse a user-typed amount into integer cents.
 *
 * Accepts "45", "45.5", "45.50" and ",50" as a decimal comma, because the launch
 * market writes 45,50 and a form that silently rejects the local decimal
 * separator reads as broken. Rejects more than two decimal places rather than
 * rounding: if someone typed 45.555 we do not know which of 45.55 or 45.56 they
 * meant, and quietly picking one is how a ledger stops matching a bank.
 */
export function parseAmountToCents(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/,/g, ".");
  if (!trimmed) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  return cents;
}

/** Validate + normalise a staff-submitted manual payment form. */
export function validateManualPaymentInput(raw: {
  amount?: unknown;
  currency?: unknown;
  method?: unknown;
  reference?: unknown;
  note?: unknown;
  receivedOn?: unknown;
}): ManualPaymentValidationResult {
  const amountCents = parseAmountToCents(raw.amount);
  if (amountCents === null) {
    return { ok: false, error: "Enter an amount like 45.50 (two decimal places at most)." };
  }
  if (amountCents > AMOUNT_CENTS_MAX) {
    return { ok: false, error: "That amount looks like a typo — check it and try again." };
  }

  const method = typeof raw.method === "string" ? raw.method : "";
  if (!(PAYMENT_METHODS as readonly string[]).includes(method)) {
    return { ok: false, error: "Choose how the payment was received." };
  }

  // A future-dated receipt is a typo, not a forecast: this records money that
  // HAS arrived. Compared date-only, so "today" is never rejected by a timezone.
  const receivedRaw = typeof raw.receivedOn === "string" ? raw.receivedOn.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedRaw)) {
    return { ok: false, error: "Enter the date the payment was received." };
  }
  const received = new Date(`${receivedRaw}T00:00:00Z`);
  if (Number.isNaN(received.getTime())) {
    return { ok: false, error: "Enter the date the payment was received." };
  }
  const todayUtc = new Date();
  const todayKey = todayUtc.toISOString().slice(0, 10);
  if (receivedRaw > todayKey) {
    return { ok: false, error: "The received date cannot be in the future." };
  }

  const referenceRaw = typeof raw.reference === "string" ? raw.reference.trim() : "";
  if (referenceRaw.length > REFERENCE_MAX) {
    return { ok: false, error: `Reference is too long (max ${REFERENCE_MAX} characters).` };
  }
  const noteRaw = typeof raw.note === "string" ? raw.note.trim() : "";
  if (noteRaw.length > NOTE_MAX) {
    return { ok: false, error: `Note is too long (max ${NOTE_MAX} characters).` };
  }

  const currencyRaw = typeof raw.currency === "string" ? raw.currency.trim().toUpperCase() : "";
  const currency = currencyRaw || "EUR";
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, error: "Currency must be a three-letter code like EUR." };
  }

  return {
    ok: true,
    value: {
      amountCents,
      currency,
      method: method as PaymentMethod,
      reference: referenceRaw || null,
      note: noteRaw || null,
      receivedOn: receivedRaw,
    },
  };
}

/**
 * A member's off-card payments, newest received first, with staff attribution
 * resolved. Staff see the whole tenant's rows for the member via
 * `manual_payment_staff_all`; a member sees only their own via
 * `manual_payment_self_select` (both migration 0026).
 *
 * `left join` on both staff joins, not `join`: `entered_by`/`voided_by` are
 * nullable and set to null when a staff account is removed, and an inner join
 * would silently drop that payment from the member's billing history — losing a
 * financial record to a departed employee.
 */
export const MANUAL_PAYMENTS_FOR_MEMBER_SQL = `
  select mp.id, mp.tenant_id, mp.member_id, mp.amount_cents, mp.currency,
         mp.method, mp.reference, mp.note, mp.received_on, mp.entered_by,
         entered.full_name as entered_by_name,
         mp.voided_at, voided.full_name as voided_by_name, mp.void_reason,
         mp.created_at
    from manual_payment mp
    left join users entered on entered.id = mp.entered_by
    left join users voided  on voided.id  = mp.voided_by
   where mp.member_id = $1
   order by mp.received_on desc, mp.created_at desc`;

export async function manualPaymentsForMember(
  identity: Identity,
  memberId: string,
): Promise<ManualPaymentRow[]> {
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<ManualPaymentRow>(MANUAL_PAYMENTS_FOR_MEMBER_SQL, [memberId]);
    return rows;
  });
}

export type RecordPaymentResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Record an off-card payment against a member.
 *
 * `entered_by` is resolved from the verified session, never from the form — the
 * whole value of the provenance column is that it cannot be asserted by the
 * submitter. The member_id IS taken as an argument, but RLS
 * (`manual_payment_staff_all`'s WITH CHECK plus the composite
 * `(member_id, tenant_id)` FK) rejects a member outside the caller's tenant.
 */
export async function recordManualPayment(
  identity: Identity,
  memberId: string,
  input: ManualPaymentInput,
): Promise<RecordPaymentResult> {
  if (identity.role !== "staff") {
    return { ok: false, error: "Only staff can record a payment." };
  }

  return withTenantContext(identity, async (c) => {
    // Resolve the acting staff row from the verified auth id, via the same
    // helper the GDPR audit trail uses. Nullable result is tolerated: a session
    // whose users row is missing should still be able to record the payment
    // (losing attribution beats losing the record).
    const enteredBy = await resolveActorUserId(c, identity.userId);

    const { rows } = await c.query<{ id: string }>(
      `insert into manual_payment
         (tenant_id, member_id, amount_cents, currency, method, reference, note,
          received_on, entered_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        identity.tenantId,
        memberId,
        input.amountCents,
        input.currency,
        input.method,
        input.reference,
        input.note,
        input.receivedOn,
        enteredBy,
      ],
    );
    return { ok: true as const, id: rows[0].id };
  });
}

/**
 * Void a payment. There is no edit path — see 0026's header for why a ledger
 * that can be rewritten is worth less than none.
 *
 * `where voided_at is null` makes this idempotent and makes a double-void a
 * no-op rather than an overwrite of the original voider and reason, which would
 * destroy the audit trail the void exists to create.
 */
export async function voidManualPayment(
  identity: Identity,
  paymentId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (identity.role !== "staff") {
    return { ok: false, error: "Only staff can void a payment." };
  }
  const trimmed = reason.trim();
  if (!trimmed) {
    return { ok: false, error: "Give a reason for voiding this payment." };
  }
  if (trimmed.length > NOTE_MAX) {
    return { ok: false, error: `Reason is too long (max ${NOTE_MAX} characters).` };
  }

  return withTenantContext(identity, async (c) => {
    const voidedBy = await resolveActorUserId(c, identity.userId);

    const result = await c.query(
      `update manual_payment
          set voided_at = now(), voided_by = $2, void_reason = $3
        where id = $1 and voided_at is null`,
      [paymentId, voidedBy, trimmed],
    );
    if (result.rowCount === 0) {
      return { ok: false as const, error: "That payment was not found, or is already voided." };
    }
    return { ok: true as const };
  });
}

/**
 * The reconciliation figures the owner's revenue view shows: card total, manual
 * total, and combined — the "one authoritative figure" EDGE calls for.
 *
 * Both halves are summed in ONE round trip over a date window, and both
 * `coalesce` to 0 so a tenant with no payments of one kind reports 0 rather than
 * null (which would render as an empty cell and read as "unknown", not "none").
 *
 * Voided manual rows are excluded, and only `succeeded` card events counted — a
 * failed charge is not revenue. That asymmetry is the reason this is one
 * hand-written query rather than two generic sums.
 */
export type RevenueTotals = {
  stripe_cents: number;
  manual_cents: number;
  combined_cents: number;
};

export const REVENUE_TOTALS_SQL = `
  with card as (
    select coalesce(sum(amount_cents), 0)::bigint as cents
      from payment_events
     where status = 'succeeded'
       and occurred_at >= $1 and occurred_at < ($2::date + 1)
  ),
  manual as (
    select coalesce(sum(amount_cents), 0)::bigint as cents
      from manual_payment
     where voided_at is null
       and received_on >= $1 and received_on <= $2
  )
  select card.cents::text as stripe_cents,
         manual.cents::text as manual_cents,
         (card.cents + manual.cents)::text as combined_cents
    from card, manual`;

export async function revenueTotals(
  identity: Identity,
  fromDate: string,
  toDate: string,
): Promise<RevenueTotals> {
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<Record<keyof RevenueTotals, string>>(REVENUE_TOTALS_SQL, [
      fromDate,
      toDate,
    ]);
    const row = rows[0];
    return {
      stripe_cents: Number(row.stripe_cents),
      manual_cents: Number(row.manual_cents),
      combined_cents: Number(row.combined_cents),
    };
  });
}

/** Format integer cents for display, e.g. 4550 -> "45.50". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
