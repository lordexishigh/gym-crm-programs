// Scheduled membership-expiry reminder (market gap #7).
//
// Finds every ACTIVE subscription (member_plans.status = 'active') whose
// current billing period ends within the next 7 days and emails the member a
// renewal reminder. Meant to run once a day via a scheduler (see
// .github/workflows/membership-expiry.yml) — there is no in-process cron in
// a serverless Next.js deployment, so this is a standalone script like
// scripts/seed.mjs, run with its own DB connection and a direct Resend HTTP
// call (it can't import the TypeScript lib/ modules without a build step, so
// the email HTML is a small, deliberately duplicated copy of
// lib/notifications.ts's sendMembershipExpiryEmail).
//
// Usage:
//   node scripts/notify-membership-expiry.mjs
//
// Requires: DATABASE_URL (or MIGRATE_DATABASE_URL), RESEND_API_KEY,
// INVITE_FROM_EMAIL (reused as the sender for this reminder too).

import "dotenv/config";
import pg from "pg";

const DB_URL = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.INVITE_FROM_EMAIL;

function requireEnv() {
  const missing = [];
  if (!DB_URL) missing.push("DATABASE_URL");
  if (!RESEND_API_KEY) missing.push("RESEND_API_KEY");
  if (!FROM_EMAIL) missing.push("INVITE_FROM_EMAIL");
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(", ")} (see .env.example).`);
    process.exit(1);
  }
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendExpiryEmail({ to, memberName, planName, expiresAt }) {
  const safeName = escapeHtml(memberName);
  const safePlan = escapeHtml(planName);
  const when = expiresAt.toLocaleDateString("en-GB", { dateStyle: "long" });

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      subject: `Your ${planName} membership renews soon`,
      html: `<!doctype html><html><body style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#0f172a;line-height:1.5">
        <p>Hi ${safeName},</p>
        <p>Your <strong>${safePlan}</strong> membership is due to renew on ${when}. No action is needed if your payment details are current.</p>
      </body></html>`,
      text: `Hi ${memberName},\n\nYour ${planName} membership is due to renew on ${when}. No action is needed if your payment details are current.`,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Resend send failed (HTTP ${res.status}): ${body.message || "unknown error"}`);
  }
}

async function main() {
  requireEnv();
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const { rows } = await client.query(`
      select m.email, m.full_name, p.name as plan_name, mp.current_period_end
        from member_plans mp
        join member m on m.id = mp.member_id
        join membership_plans p on p.id = mp.plan_id
       where mp.status = 'active'
         and mp.current_period_end is not null
         and mp.current_period_end between now() and now() + interval '7 days'
         and m.email is not null
    `);

    console.log(`Found ${rows.length} membership(s) renewing within 7 days.`);

    let sent = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await sendExpiryEmail({
          to: row.email,
          memberName: row.full_name,
          planName: row.plan_name,
          expiresAt: new Date(row.current_period_end),
        });
        sent += 1;
      } catch (err) {
        failed += 1;
        console.error(`! failed to email ${row.email}: ${err.message}`);
      }
    }

    console.log(`Done: ${sent} sent, ${failed} failed.`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Membership expiry notification run failed:", err.message || err);
  process.exit(1);
});
