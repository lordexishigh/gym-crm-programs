import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PAYMENT_METHODS,
  formatCents,
  parseAmountToCents,
  validateManualPaymentInput,
} from "../lib/payments";

const MIGRATION = readFileSync(
  path.join(process.cwd(), "migrations", "0026_manual_payments.sql"),
  "utf8",
);
const PAYMENTS_SRC = readFileSync(path.join(process.cwd(), "lib", "payments.ts"), "utf8");

const base = {
  amount: "45.50",
  method: "sepa",
  receivedOn: "2026-01-15",
};

describe("parseAmountToCents", () => {
  it("parses whole and decimal amounts exactly", () => {
    expect(parseAmountToCents("45")).toBe(4500);
    expect(parseAmountToCents("45.5")).toBe(4550);
    expect(parseAmountToCents("45.50")).toBe(4550);
    expect(parseAmountToCents("0.01")).toBe(1);
  });

  // The launch market writes 45,50. A form that rejects the local decimal
  // separator reads as broken software.
  it("accepts a decimal comma", () => {
    expect(parseAmountToCents("45,50")).toBe(4550);
    expect(parseAmountToCents("1234,05")).toBe(123405);
  });

  // Rounding 45.555 means guessing between 45.55 and 45.56, and a guess is how a
  // ledger stops matching a bank statement. Reject instead.
  it("rejects more than two decimal places rather than rounding", () => {
    expect(parseAmountToCents("45.555")).toBe(null);
    expect(parseAmountToCents("0.001")).toBe(null);
  });

  it("rejects zero, negatives and non-numeric junk", () => {
    expect(parseAmountToCents("0")).toBe(null);
    expect(parseAmountToCents("0.00")).toBe(null);
    expect(parseAmountToCents("-45")).toBe(null);
    expect(parseAmountToCents("abc")).toBe(null);
    expect(parseAmountToCents("")).toBe(null);
    expect(parseAmountToCents("  ")).toBe(null);
    expect(parseAmountToCents(45.5)).toBe(null);
    expect(parseAmountToCents(null)).toBe(null);
  });

  // No float ever touches the value, so this stays exact where 0.1+0.2 would not.
  it("is exact for amounts a float would round", () => {
    expect(parseAmountToCents("0.29")).toBe(29);
    expect(parseAmountToCents("1.15")).toBe(115);
    expect(parseAmountToCents("8.10")).toBe(810);
  });
});

describe("formatCents", () => {
  it("round-trips with parseAmountToCents", () => {
    for (const s of ["45.50", "0.01", "1234.05", "8.10", "100.00"]) {
      expect(formatCents(parseAmountToCents(s) as number)).toBe(s);
    }
  });

  it("always pads to two decimal places", () => {
    expect(formatCents(4500)).toBe("45.00");
    expect(formatCents(5)).toBe("0.05");
    expect(formatCents(0)).toBe("0.00");
  });
});

describe("validateManualPaymentInput", () => {
  it("accepts a full valid submission and normalises it", () => {
    const r = validateManualPaymentInput({
      ...base,
      reference: "  SEPA-99123  ",
      note: "  paid at the desk  ",
      currency: "eur",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amountCents).toBe(4550);
    expect(r.value.method).toBe("sepa");
    expect(r.value.reference).toBe("SEPA-99123");
    expect(r.value.note).toBe("paid at the desk");
    expect(r.value.currency).toBe("EUR");
    expect(r.value.receivedOn).toBe("2026-01-15");
  });

  it("defaults the currency to EUR and treats blank optionals as null", () => {
    const r = validateManualPaymentInput({ ...base, reference: "   ", note: "" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.currency).toBe("EUR");
    expect(r.value.reference).toBe(null);
    expect(r.value.note).toBe(null);
  });

  it("rejects an unknown payment method", () => {
    expect(validateManualPaymentInput({ ...base, method: "bitcoin" }).ok).toBe(false);
    expect(validateManualPaymentInput({ ...base, method: "" }).ok).toBe(false);
  });

  it("accepts every method the migration allows", () => {
    for (const method of PAYMENT_METHODS) {
      expect(validateManualPaymentInput({ ...base, method }).ok, method).toBe(true);
    }
  });

  // This records money that HAS arrived, so a future date is a typo.
  it("rejects a future received date but accepts today", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(validateManualPaymentInput({ ...base, receivedOn: today }).ok).toBe(true);
    expect(validateManualPaymentInput({ ...base, receivedOn: "2999-01-01" }).ok).toBe(false);
  });

  it("rejects a malformed or missing received date", () => {
    expect(validateManualPaymentInput({ ...base, receivedOn: "15/01/2026" }).ok).toBe(false);
    expect(validateManualPaymentInput({ ...base, receivedOn: "" }).ok).toBe(false);
    expect(validateManualPaymentInput({ ...base, receivedOn: "2026-13-45" }).ok).toBe(false);
  });

  it("rejects an implausible amount rather than storing a typo", () => {
    expect(validateManualPaymentInput({ ...base, amount: "99999999" }).ok).toBe(false);
  });

  it("rejects over-long reference and note", () => {
    expect(validateManualPaymentInput({ ...base, reference: "x".repeat(141) }).ok).toBe(false);
    expect(validateManualPaymentInput({ ...base, note: "x".repeat(501) }).ok).toBe(false);
  });

  it("rejects a non-ISO currency code", () => {
    expect(validateManualPaymentInput({ ...base, currency: "EUROS" }).ok).toBe(false);
    expect(validateManualPaymentInput({ ...base, currency: "E1R" }).ok).toBe(false);
  });
});

/**
 * The reconciliation query decides what the owner believes their revenue is, and
 * there is no local Postgres to run it against. These pin the properties whose
 * loss is silent — each would produce a plausible WRONG number rather than an
 * error, which is the failure mode that destroys trust in the dashboard.
 */
describe("REVENUE_TOTALS_SQL contract", () => {
  const sql = PAYMENTS_SRC.slice(
    PAYMENTS_SRC.indexOf("export const REVENUE_TOTALS_SQL"),
    PAYMENTS_SRC.indexOf("export async function revenueTotals"),
  );

  it("is extracted from the source (guards the assertions below)", () => {
    expect(sql).toContain("with card as");
    expect(sql).toContain("manual as");
  });

  it("counts only succeeded card payments — a failed charge is not revenue", () => {
    expect(sql).toContain("status = 'succeeded'");
  });

  it("excludes voided manual payments", () => {
    expect(sql).toContain("voided_at is null");
  });

  // A null sum would render as an empty cell and read as "unknown" rather than
  // "none", and would poison the combined total via null arithmetic.
  it("coalesces both sums to 0", () => {
    expect(sql.match(/coalesce\(sum\(amount_cents\), 0\)/g)?.length).toBe(2);
  });

  // Money is summed as bigint and handed over as text: a tenant's lifetime cents
  // can exceed what pg returns safely as a JS number via the default int parse.
  it("sums as bigint and returns text, never a float", () => {
    expect(sql).toContain("::bigint");
    expect(sql.match(/::text/g)?.length).toBe(3);
    expect(sql).not.toMatch(/::(float|numeric|real|double)/);
  });
});

describe("migration 0026_manual_payments", () => {
  it("enables AND forces RLS", () => {
    expect(MIGRATION).toContain("enable row level security");
    expect(MIGRATION).toContain("force  row level security");
  });

  it("gives staff full access and members read-only access to their own rows", () => {
    expect(MIGRATION).toContain("manual_payment_staff_all");
    expect(MIGRATION).toContain("manual_payment_self_select");
    // A member must never be able to assert that they paid cash.
    const selfPolicy = MIGRATION.slice(MIGRATION.indexOf("manual_payment_self_select"));
    expect(selfPolicy).toContain("for select");
    expect(selfPolicy).not.toContain("with check");
  });

  it("scopes the member FK by tenant, so a cross-tenant member id cannot be used", () => {
    expect(MIGRATION).toMatch(/references member \(id, tenant_id\)/);
  });

  // A row that is voided-without-a-reason reads as live to the revenue query
  // while looking voided in the UI.
  it("makes a void all-or-nothing", () => {
    expect(MIGRATION).toContain("manual_payment_void_complete");
  });

  it("keeps financial history when a staff account is removed", () => {
    expect(MIGRATION).toMatch(/on delete set null \(entered_by\)/);
    expect(MIGRATION).toMatch(/on delete set null \(voided_by\)/);
  });

  it("rejects a non-positive amount at the database, not just in validation", () => {
    expect(MIGRATION).toContain("check (amount_cents > 0)");
  });

  // GDPR erasure DELETEs nothing here but must UPDATE the free-text columns —
  // the missing-grant class of bug that migration 0018 had to fix for workout_log.
  it("grants app_user the update needed by the void and erasure paths", () => {
    expect(MIGRATION).toMatch(/grant select, insert, update, delete on manual_payment to app_user/);
  });
});
