import { isEmailConfigured } from "@/lib/email/resend";
import { authConfigured } from "@/lib/auth/supabase";

/**
 * What this deployment can actually do.
 *
 * The problem this solves is specific and has bitten this project repeatedly:
 * an optional integration is absent in production, every code path that needs it
 * degrades politely and silently, and the feature is reported as shipped because
 * the code is there. Transactional email is the live example — production has no
 * `RESEND_API_KEY`, so every `sendEmail()` returns `not_configured`, which means
 * the member-invite flow completes successfully and sends nothing. Nothing in
 * the product says so. A trainer invites a member, sees a success message, and
 * waits.
 *
 * The fix is not more logging. It is to state the deployment's capabilities
 * up front, in one place, with the CONSEQUENCE of each absence attached — so a
 * gap is something an operator reads on the dashboard and in /api/health, rather
 * than something they infer weeks later from a member who never arrived.
 *
 * Every entry names what is missing (`missing`) and what stops working
 * (`consequence`). `severity` separates "the app cannot serve" from "a feature
 * is quietly inert", because conflating those is how a soft gap gets ignored and
 * a hard one gets treated as noise:
 *
 *   "required" — the app cannot function. Only the database qualifies.
 *   "degraded" — the app serves, but a user-visible promise silently is not
 *                kept. This is the dangerous class, and the one this module
 *                exists to make loud.
 *   "optional" — a feature is switched off and nothing promises otherwise.
 *
 * Deliberately env-only and synchronous: no I/O, no database, no imports beyond
 * two zero-dependency config predicates. It is safe to call from a server
 * component, a route handler or a script, and it cannot itself fail in a way
 * that hides the gaps it is reporting.
 */

export type CapabilitySeverity = "required" | "degraded" | "optional";

export type Capability = {
  /** Stable id for logs, tests and the health payload. */
  id: string;
  /** Human label for the dashboard notice. */
  label: string;
  configured: boolean;
  severity: CapabilitySeverity;
  /** Env vars that are absent (empty when configured). */
  missing: string[];
  /** What silently does not happen while this is unconfigured. */
  consequence: string;
};

/** Names of the env vars that are unset or blank, from a candidate list. */
function missingEnv(names: string[]): string[] {
  return names.filter((n) => !process.env[n]?.trim());
}

/**
 * Whether scheduled work can run on this deployment.
 *
 * `CRON_SECRET` is what /api/tasks/dispatch authenticates with, so without it
 * the queue has no trigger: tasks accumulate at 'pending' past their `due_at`
 * and nothing drains them. That failure is completely invisible from the
 * outside — reminders simply never arrive — which is exactly the class of gap
 * this module exists to surface.
 */
function schedulerConfigured(): boolean {
  return Boolean(process.env.CRON_SECRET?.trim());
}

/**
 * Whether a language-model generator is available.
 *
 * Absent by default and by design. Nothing in the product depends on it: the
 * suggestion ledger (lib/suggestions.ts) is fed by rules-based generators that
 * need no provider, and an LLM generator can only ever add WEAK suggestions for
 * a trainer to review (see `priceEvidence`). So this is "optional", not
 * "degraded" — no promise is broken by its absence.
 */
function aiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/** Enumerate this deployment's capabilities, in reporting order. */
export function capabilities(): Capability[] {
  return [
    {
      id: "database",
      label: "Database",
      configured: Boolean(process.env.DATABASE_URL?.trim()),
      severity: "required",
      missing: missingEnv(["DATABASE_URL"]),
      consequence:
        "No page that reads or writes gym data can render; the app serves errors.",
    },
    {
      id: "auth",
      label: "Sign-in",
      configured: authConfigured(),
      severity: "required",
      missing: missingEnv([
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      ]),
      consequence:
        "The login pages render but nobody — staff or member — can get past them.",
    },
    {
      id: "email",
      label: "Transactional email",
      configured: isEmailConfigured(),
      severity: "degraded",
      missing: missingEnv(["RESEND_API_KEY", "INVITE_FROM_EMAIL"]),
      consequence:
        "Member invites, booking confirmations, waitlist promotions and renewal reminders are accepted and never delivered. Invite links must be copied and shared by hand.",
    },
    {
      id: "scheduler",
      label: "Scheduled jobs",
      configured: schedulerConfigured(),
      severity: "degraded",
      missing: missingEnv(["CRON_SECRET"]),
      consequence:
        "Nothing drains the task queue: renewal reminders and at-risk briefs stay queued past their due date and never run.",
    },
    {
      id: "payments",
      label: "Payments (Stripe)",
      configured: Boolean(process.env.STRIPE_SECRET_KEY?.trim()),
      /**
       * "degraded", not "optional" — corrected 2026-08-20 against the real
       * production project, which has neither variable set.
       *
       * The old classification said payments were "deliberately off on this
       * product", and that is not what the product does. The owner's billing
       * panel offers a "Send checkout link" button, `assignPlanAction` tells them
       * in so many words to "send the member a checkout link to collect payment",
       * and the portal shows a payment history that only the Stripe webhook ever
       * writes to. Those are promises, so their absence is a broken promise —
       * the exact class this module exists to make loud. An automated review has
       * duly reported the Stripe integration as "built but the running app
       * doesn't serve it", and it was right: the code ships, the keys do not,
       * and nothing anywhere said so.
       */
      severity: "degraded",
      missing: missingEnv(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]),
      consequence:
        "No money can be collected: checkout links cannot be created, so an assigned plan stays 'pending' forever, the portal's payment history stays empty, and the automated failed-payment retry never runs because Stripe has nowhere to deliver events. Plans can still be assigned and tracked by hand.",
    },
    {
      id: "ai",
      label: "AI suggestions",
      configured: aiConfigured(),
      severity: "optional",
      missing: missingEnv(["ANTHROPIC_API_KEY"]),
      consequence:
        "Model-drafted suggestions are unavailable. Rules-based suggestions (at-risk briefs) are unaffected — they need no provider.",
    },
  ];
}

/**
 * The gaps worth telling an operator about: anything unconfigured that breaks a
 * promise the product makes. "optional" gaps are excluded — a switched-off
 * feature that nothing references is not a problem, and reporting it as one
 * trains people to ignore this list.
 */
export function capabilityGaps(): Capability[] {
  return capabilities().filter(
    (c) => !c.configured && c.severity !== "optional",
  );
}

/** Look one capability up by id. */
export function capability(id: string): Capability | undefined {
  return capabilities().find((c) => c.id === id);
}

/** Whether a capability is configured. Convenience for feature gating. */
export function hasCapability(id: string): boolean {
  return capability(id)?.configured ?? false;
}

/**
 * Compact `{ id: "configured" | "unconfigured" }` map for the health payload.
 *
 * A map rather than the full array so /api/health stays terse enough to read in
 * a terminal, while the dashboard notice (which has room to explain) renders the
 * consequences from `capabilityGaps()`.
 */
export function capabilitySummary(): Record<
  string,
  "configured" | "unconfigured"
> {
  const out: Record<string, "configured" | "unconfigured"> = {};
  for (const c of capabilities()) {
    out[c.id] = c.configured ? "configured" : "unconfigured";
  }
  return out;
}
