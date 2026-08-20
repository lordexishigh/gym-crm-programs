import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  capabilities,
  capability,
  capabilityGaps,
  capabilitySummary,
  hasCapability,
} from "../lib/capabilities";

/**
 * The capability manifest.
 *
 * What this guards: production has no `RESEND_API_KEY`, so every `sendEmail()`
 * returns `not_configured` and every path that mails a member degrades silently.
 * A trainer invites someone, sees a success message, and waits. The manifest
 * exists so that gap is reported rather than inferred weeks later — which only
 * works if the severity classes stay honest, so they are pinned here.
 */

const TOUCHED = [
  "DATABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "RESEND_API_KEY",
  "INVITE_FROM_EMAIL",
  "CRON_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "ANTHROPIC_API_KEY",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of TOUCHED) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of TOUCHED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function configureAll() {
  process.env.DATABASE_URL = "postgres://localhost:5432/alpha_crm";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://auth.example.test";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_x";
  process.env.RESEND_API_KEY = "re_x";
  process.env.INVITE_FROM_EMAIL = "Alpha CRM <noreply@example.test>";
  process.env.CRON_SECRET = "s".repeat(32);
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
  process.env.ANTHROPIC_API_KEY = "sk-ant-x";
}

describe("capabilities", () => {
  it("reports every capability as unconfigured on a bare environment", () => {
    expect(capabilities().every((c) => !c.configured)).toBe(true);
  });

  it("reports every capability as configured when the environment is complete", () => {
    configureAll();
    expect(capabilities().every((c) => c.configured)).toBe(true);
    expect(capabilityGaps()).toEqual([]);
  });

  it("names the specific variables that are missing", () => {
    process.env.RESEND_API_KEY = "re_x";
    const email = capability("email")!;
    expect(email.configured).toBe(false);
    // Half-configured is the dangerous state: it looks set up.
    expect(email.missing).toEqual(["INVITE_FROM_EMAIL"]);
  });

  it("treats a whitespace-only value as unset", () => {
    // A half-filled .env or a CI secret that resolved to "" must not read as a
    // working integration.
    process.env.CRON_SECRET = "   ";
    expect(hasCapability("scheduler")).toBe(false);
  });

  it("states a consequence for every capability", () => {
    // A gap with no stated consequence is a gap nobody acts on.
    for (const c of capabilities()) {
      expect(c.consequence.length).toBeGreaterThan(20);
    }
  });
});

describe("capabilityGaps", () => {
  it("excludes optional capabilities so the list stays worth reading", () => {
    // AI is genuinely off on this product: rules-based suggestions need no
    // provider, so nothing promises a model. Reporting that as a problem trains
    // people to ignore the notice that also carries email.
    const ids = capabilityGaps().map((c) => c.id);
    expect(ids).not.toContain("ai");
  });

  it("includes email, the scheduler and payments — the silent failures", () => {
    const ids = capabilityGaps().map((c) => c.id);
    expect(ids).toContain("email");
    expect(ids).toContain("scheduler");
    // Payments used to be excluded as "optional". Production has no Stripe keys,
    // and the owner's billing panel still offers a checkout link that cannot be
    // created — so its absence breaks a promise the product makes on screen and
    // belongs in the notice.
    expect(ids).toContain("payments");
  });

  it("classifies email, scheduler and payments as degraded, not required", () => {
    // They must not fail a health probe: the app genuinely serves without them,
    // and a hard failure here would take every readiness gate down with it.
    expect(capability("email")!.severity).toBe("degraded");
    expect(capability("scheduler")!.severity).toBe("degraded");
    expect(capability("payments")!.severity).toBe("degraded");
    expect(capability("database")!.severity).toBe("required");
  });

  it("names both Stripe variables as missing when payments are unconfigured", () => {
    // The consequence is only actionable if it says what to set. Both are
    // needed: the secret key creates checkout sessions, the webhook secret is
    // what makes the failed-payment retry loop trustworthy.
    expect(capability("payments")!.missing).toEqual([
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ]);
  });

  it("keeps AI optional, so no deployment is degraded by its absence", () => {
    // Rules-based suggestions need no provider, which is what makes this safe to
    // leave unconfigured indefinitely.
    expect(capability("ai")!.severity).toBe("optional");
  });
});

describe("capabilitySummary", () => {
  it("maps every capability id to a configured state", () => {
    configureAll();
    const summary = capabilitySummary();
    expect(Object.keys(summary).sort()).toEqual(
      capabilities()
        .map((c) => c.id)
        .sort(),
    );
    expect(Object.values(summary).every((v) => v === "configured")).toBe(true);
  });
});

describe("hasCapability", () => {
  it("is false for an unknown id rather than throwing", () => {
    // Feature gates read this; an unknown id must fail closed.
    expect(hasCapability("no-such-capability")).toBe(false);
  });
});
