// Verify Resend transactional sending end-to-end, INCLUDING delivery
// (mvp-member-management-002, extended for beta-hardening).
//
// Sends one email using the same env-configured credentials the app uses
// (RESEND_API_KEY + INVITE_FROM_EMAIL), then polls Resend until it reports what
// happened to it. Exits non-zero unless the message was actually DELIVERED.
//
// Usage:
//   node scripts/send-test-email.mjs you@example.com
//   npm run verify:email                     # recipient from VERIFY_EMAIL_TO
//   node scripts/send-test-email.mjs you@example.com --no-wait
//
// Env:
//   VERIFY_EMAIL_TO          recipient, when not passed as an argument. Lets
//                            this run unattended from a cron or a deploy hook.
//   VERIFY_EMAIL_TIMEOUT_MS  how long to wait for a terminal state (default 60s).
//
// WHY THE POLL, AND NOT JUST THE SEND
//
// A 200 from POST /emails means Resend ACCEPTED the message, which is a much
// weaker claim than it looks: a domain whose DKIM record was edited, a suppressed
// recipient, or a receiving server rejecting our IP all produce a clean 200 and
// an id, then fail silently afterwards. This script used to stop there and print
// "Sent." — so it would have passed on a deployment that could not deliver a
// single invite. The only externally visible symptom of that is members not
// arriving, which nobody notices for weeks.
//
// So it asks the question that matters: GET /emails/{id} until `last_event`
// reaches a terminal state. That covers credentials, DNS (SPF/DKIM) and
// recipient-side acceptance in one check, without needing to read an inbox.
//
// It calls the Resend HTTP API directly (mirrors lib/email/resend.ts) so it has
// no build/import dependency on the Next app — which is also why the event names
// below are restated rather than imported from lib/email/webhook.ts. Those are
// the webhook's `email.`-prefixed types; the ones here are the bare `last_event`
// values the REST API returns.

import "dotenv/config";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const POLL_INTERVAL_MS = 2000;

/**
 * Terminal states.
 *
 * `opened` and `clicked` carry no deliverability signal of their own (the
 * webhook route ignores them for exactly that reason) but they cannot occur
 * unless the message landed, so they count as success rather than as "still
 * waiting" — otherwise a fast recipient reading the mail inside the poll window
 * would time this out as a failure.
 *
 * `delivery_delayed` is NOT terminal: the receiving server asked us to retry and
 * Resend will, so the honest answer is "not yet known".
 */
const DELIVERED = new Set(["delivered", "opened", "clicked"]);
const FAILED = new Set(["bounced", "complained", "failed", "suppressed"]);

const args = process.argv.slice(2);
const noWait = args.includes("--no-wait");
const to = args.find((a) => !a.startsWith("--")) || process.env.VERIFY_EMAIL_TO?.trim();

if (!to) {
  console.error(
    "Usage: node scripts/send-test-email.mjs <recipient@example.com> [--no-wait]\n" +
      "   or: set VERIFY_EMAIL_TO and run `npm run verify:email`",
  );
  process.exit(1);
}

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.INVITE_FROM_EMAIL;
if (!apiKey || !from) {
  console.error("RESEND_API_KEY and INVITE_FROM_EMAIL must be set (see .env.example).");
  process.exit(1);
}

const authHeaders = { Authorization: `Bearer ${apiKey}` };
const timeoutMs = Number(process.env.VERIFY_EMAIL_TIMEOUT_MS || 60_000);

const sendRes = await fetch(RESEND_ENDPOINT, {
  method: "POST",
  headers: { ...authHeaders, "Content-Type": "application/json" },
  body: JSON.stringify({
    from,
    to: [to],
    subject: "Alpha CRM — test email",
    html: "<p>This is a test transactional email from Alpha CRM. If you received it, Resend is wired up correctly.</p>",
    text: "This is a test transactional email from Alpha CRM. If you received it, Resend is wired up correctly.",
  }),
});

const sendBody = await sendRes.json().catch(() => ({}));
if (!sendRes.ok || !sendBody.id) {
  console.error(`Send failed (HTTP ${sendRes.status}):`, sendBody.message || sendBody);
  process.exit(1);
}

const id = sendBody.id;
console.log(`Accepted by Resend. Message id: ${id}`);
console.log(`  from: ${from}`);
console.log(`  to:   ${to}`);

if (noWait) {
  // Explicit about what was and was not established, so a --no-wait run in a log
  // is never mistaken for a delivery confirmation.
  console.log("--no-wait: not confirming delivery. Acceptance is not delivery.");
  process.exit(0);
}

const deadline = Date.now() + timeoutMs;
let lastEvent = sendBody.last_event || "queued";

while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

  const res = await fetch(`${RESEND_ENDPOINT}/${id}`, {
    headers: authHeaders,
    cache: "no-store",
  });
  if (!res.ok) {
    // A transient 5xx from the status endpoint is not evidence about the email.
    // Keep polling until the deadline rather than reporting a delivery failure
    // that did not happen.
    console.log(`  (status check returned HTTP ${res.status}, retrying)`);
    continue;
  }

  const body = await res.json().catch(() => ({}));
  if (body.last_event && body.last_event !== lastEvent) {
    lastEvent = body.last_event;
    console.log(`  ${lastEvent}`);
  }

  if (DELIVERED.has(lastEvent)) {
    console.log(`\nDelivered. Resend reports "${lastEvent}" for ${to}.`);
    console.log(
      "Open the message and check Show original for SPF=pass and DKIM=pass — " +
        "delivery to the server does not by itself prove authentication passed.",
    );
    process.exit(0);
  }

  if (FAILED.has(lastEvent)) {
    console.error(`\nNOT delivered. Resend reports "${lastEvent}" for ${to}.`);
    if (body.bounce?.message) console.error(`  reason: ${body.bounce.message}`);
    console.error(
      lastEvent === "suppressed"
        ? "  This address is on the suppression list from an earlier bounce or complaint."
        : "  Check the domain's SPF/DKIM records and the recipient address.",
    );
    process.exit(1);
  }
}

// Timing out is a real result worth failing on, but it is not the same result as
// a bounce, so it says so. Stuck at `sent` usually means the receiving server
// accepted the connection and has not yet acknowledged the message.
console.error(
  `\nTimed out after ${timeoutMs}ms. Last state: "${lastEvent}" — accepted by Resend, ` +
    `delivery unconfirmed.`,
);
console.error(`Check https://resend.com/emails/${id} for the current state.`);
process.exit(1);
