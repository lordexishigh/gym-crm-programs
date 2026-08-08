// Manual trigger for scheduled work (renewal reminders and everything else on
// the queue).
//
// WHAT THIS USED TO DO, AND WHY IT CHANGED.
//
// This script used to query every active plan renewing within 7 days and email
// each member directly, recording nothing. Its scheduler ran it daily, so a
// membership expiring on the 8th was inside the window on the 1st, 2nd … 7th and
// the member was emailed SEVEN times about one renewal. Nothing in the script
// could detect that, because "already sent" was never written down. It also
// carried a hand-duplicated copy of the email template from lib/notifications.ts
// (a .mjs script cannot import our TypeScript), so the two could — and did —
// drift.
//
// Both problems are gone because the work moved behind the task queue
// (migration 0020): reminders are enqueued under a dedupe key pairing the plan
// with its billing period, so any number of sweeps produce exactly one email,
// and the handler calls the real `sendMembershipExpiryEmail` rather than a copy.
//
// So this file is now a thin trigger for /api/tasks/dispatch. It duplicates no
// logic, which is the point: the sweep, the dedupe rules and the templates live
// in one place and this just asks the app to run them.
//
// The scheduled trigger in production is Vercel Cron (`crons` in vercel.json),
// not this script. Reach for this when you want to run the queue NOW — after
// fixing a parked task, or to verify a deployment's scheduled work end to end.
//
// Usage:
//   node scripts/notify-membership-expiry.mjs
//   node scripts/notify-membership-expiry.mjs https://app.example.eu
//
// Requires: CRON_SECRET, and APP_BASE_URL (or the URL as the first argument).

import "dotenv/config";

const CRON_SECRET = process.env.CRON_SECRET;
const BASE_URL =
  process.argv[2] || process.env.APP_BASE_URL || "http://localhost:3000";

/** Bound the wait: a silent server must not hang a scheduled trigger forever. */
const TIMEOUT_MS = Number(process.env.DISPATCH_TIMEOUT_MS) || 60_000;

function requireEnv() {
  if (!CRON_SECRET) {
    console.error(
      "Missing CRON_SECRET (see .env.example). The dispatch endpoint refuses " +
        "unauthenticated requests, so nothing can be triggered without it.",
    );
    process.exit(1);
  }
}

async function main() {
  requireEnv();

  const url = `${BASE_URL.replace(/\/$/, "")}/api/tasks/dispatch`;
  console.log(`Triggering scheduled work at ${url} …`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`No response within ${TIMEOUT_MS}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error(
      `Dispatch failed (HTTP ${res.status}): ${body.error || "unknown error"}`,
    );
    process.exit(1);
  }

  console.log(
    `Done: enqueued ${body.enqueued ?? 0}, claimed ${body.claimed ?? 0}, ` +
      `succeeded ${body.succeeded ?? 0}, failed ${body.failed ?? 0} ` +
      `(${body.duration_ms ?? "?"}ms).`,
  );

  // A task that failed is not a failure of the trigger — it is recorded, retried
  // with backoff, and reported. Surface it in the exit code anyway so a CI or
  // operator run does not read "succeeded" over a queue that is not draining.
  if ((body.failed ?? 0) > 0) {
    console.error(
      `${body.failed} task(s) failed — check tasks.last_error, and /api/health ` +
        "for a capability gap (an unconfigured mail provider parks every email task).",
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Scheduled-work trigger failed:", err.message || err);
  process.exit(1);
});
