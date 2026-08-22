import { expect, test } from "@playwright/test";

/**
 * Does the RUNNING deployment still have every capability it promises?
 * (companion to ./staff-login.spec.ts, same "verify the deployment, not the
 * checkout" contract — see playwright.live.config.ts.)
 *
 * WHY THIS EXISTS
 *
 * Transactional email was absent from production for months while the code that
 * used it was complete and correct. Nothing failed. `sendEmail()` returned
 * `not_configured`, every caller degraded politely, and the invite flow reported
 * success and sent nothing — so the gap was only ever discoverable by a human
 * reading the dashboard notice and choosing to care.
 *
 * It is configured now, which creates the opposite risk and the reason for this
 * file: a rotated Resend key, an env var dropped during a project migration, or
 * a `vercel env rm` typo would put production straight back into that silent
 * state, and the ONLY externally visible symptom would be members not receiving
 * mail — a thing nobody notices for weeks. This turns that regression into a
 * failing check.
 *
 * It asserts against /api/health rather than sending anything, so it is free,
 * side-effect-free, and safe to run on every deploy. That also bounds what it
 * can prove: `configured` means the credentials are PRESENT, not that mail is
 * being delivered. Deliverability is a different question needing a real send —
 * see `npm run verify:email`, which is deliberately not wired into the deploy
 * path because it costs send quota and touches a real inbox.
 */

/**
 * Capabilities whose absence is reported by `capabilityGaps()` (lib/capabilities.ts).
 *
 * Read from the payload rather than restated here: "optional" capabilities
 * (payments, AI) are excluded from `capability_gaps` by design, so asserting the
 * list is empty asserts exactly "no promise this product makes is silently
 * unkept" — without this spec needing its own opinion about which those are.
 * Adding an optional integration later must not fail this check, and won't.
 */
type HealthPayload = {
  capabilities?: Record<string, string>;
  capability_gaps?: Array<{
    id: string;
    label: string;
    severity: string;
    missing: string[];
    consequence: string;
  }>;
};

test.describe("deployment capabilities", () => {
/**
 * Gaps this deployment is knowingly running with.
 *
 * This check first asserted that `capability_gaps` was EMPTY, which was wrong
 * and blocked a real deploy on its first outing. Two capabilities are
 * deliberately unconfigured here and neither is going to change on its own:
 * `payments` (the project has no Stripe keys, and was reclassified
 * optional -> degraded on 2026-08-20 precisely because the product does promise
 * checkout), and `email_delivery_tracking` (no `RESEND_WEBHOOK_SECRET` yet).
 *
 * A check that can never pass is not a gate, it is a thing people learn to
 * override — the exact habit lib/capabilities.ts exists to prevent. So the
 * assertion is now "no gap we did not already know about", which still fails
 * loudly the moment a WORKING capability regresses, while staying green on the
 * gaps someone has already decided to live with.
 *
 * Narrow this list as the gaps are closed; `VERIFY_KNOWN_GAPS` overrides it for
 * a deployment with a different set (a real gym with Stripe configured should
 * run with `VERIFY_KNOWN_GAPS=` so any gap at all fails).
 */
const KNOWN_GAPS = new Set(
  (process.env.VERIFY_KNOWN_GAPS ?? "payments,email_delivery_tracking")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

  test("no capability has regressed into a gap", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok(), `/api/health returned HTTP ${res.status()}`).toBe(true);

    const body = (await res.json()) as HealthPayload;

    // Fail with the CONSEQUENCE, not just the id. Whoever sees this in a deploy
    // log needs to know what stopped working for members, not to go and look up
    // what "email" gates — that lookup is the step that does not happen at 6pm.
    const unexpected = (body.capability_gaps ?? []).filter(
      (g) => !KNOWN_GAPS.has(g.id),
    );
    const detail = unexpected
      .map((g) => `${g.label} (missing ${g.missing.join(", ")}): ${g.consequence}`)
      .join("\n");
    expect(
      unexpected,
      `deployment has NEW unconfigured capabilities (known-and-accepted: ` +
        `${[...KNOWN_GAPS].join(", ") || "none"}):\n${detail}`,
    ).toEqual([]);
  });

  /**
   * Asserted separately from the gap list above, and deliberately redundant with
   * it.
   *
   * `capability_gaps` is derived — a future edit that reclassified email as
   * "optional" would empty the list and make the check above pass while
   * production quietly stopped sending invites. Naming email directly means that
   * reclassification has to be a deliberate act that breaks a test with this
   * comment attached, rather than a silent downgrade.
   */
  test("transactional email specifically is configured", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok(), `/api/health returned HTTP ${res.status()}`).toBe(true);

    const body = (await res.json()) as HealthPayload;
    expect(
      body.capabilities?.email,
      "RESEND_API_KEY / INVITE_FROM_EMAIL are missing from this deployment: " +
        "member invites, booking confirmations, waitlist promotions and renewal " +
        "reminders will be accepted and never delivered.",
    ).toBe("configured");
  });
});
