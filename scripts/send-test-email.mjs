// Dev-only: verify Resend transactional sending end-to-end (mvp-member-management-002).
//
// Sends one email to a real inbox using the same env-configured credentials the
// app uses (RESEND_API_KEY + INVITE_FROM_EMAIL). Use it to satisfy the
// "test/dev send succeeds end to end to a real inbox" acceptance criterion.
//
// Usage:
//   node scripts/send-test-email.mjs you@example.com
//
// It calls the Resend HTTP API directly (mirrors lib/email/resend.ts) so it has
// no build/import dependency on the Next app.

import "dotenv/config";

const to = process.argv[2];
if (!to) {
  console.error("Usage: node scripts/send-test-email.mjs <recipient@example.com>");
  process.exit(1);
}

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.INVITE_FROM_EMAIL;
if (!apiKey || !from) {
  console.error("RESEND_API_KEY and INVITE_FROM_EMAIL must be set (see .env.example).");
  process.exit(1);
}

const res = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    from,
    to: [to],
    subject: "Alpha CRM — test email",
    html: "<p>This is a test transactional email from Alpha CRM. If you received it, Resend is wired up correctly.</p>",
    text: "This is a test transactional email from Alpha CRM. If you received it, Resend is wired up correctly.",
  }),
});

const body = await res.json().catch(() => ({}));
if (!res.ok || !body.id) {
  console.error(`Send failed (HTTP ${res.status}):`, body.message || body);
  process.exit(1);
}
console.log(`Sent. Resend message id: ${body.id}`);
