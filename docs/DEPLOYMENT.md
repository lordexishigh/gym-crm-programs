# Deployment & operations

Alpha CRM is a single Next.js (App Router) app deployed to **Vercel (EU)** with a
managed **Supabase Postgres + Auth (EU/Frankfurt)** backend, chosen for GDPR data
residency in the Cyprus launch market.

## Environments & secrets

All configuration is supplied via environment variables — **never** committed to
source. See [`.env.example`](../.env.example) for the full list.

| Variable | Where | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Vercel + CI | Privileged Postgres connection (migrations + base connection the app drops into `app_user`). |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Vercel | Public Supabase config (browser + public auth calls). |
| `SUPABASE_SECRET_KEY` | Vercel (server-only) | Admin/provisioning paths (secret key `sb_secret_...`). |
| `RESEND_API_KEY` / `INVITE_FROM_EMAIL` | Vercel (server-only) | Invite email send. `INVITE_FROM_EMAIL` must use the verified sending domain (below). |
| `RESEND_WEBHOOK_SECRET` | Vercel (server-only) | Verifies inbound Resend bounce/complaint webhooks (`whsec_...`). |
| `MONITORING_WEBHOOK_URL` / `ALERT_WEBHOOK_URL` | Vercel (server-only) | Optional. Error-monitoring sink + critical-alert sink (see Observability). |

In CI/CD these live in GitHub repository **secrets**. The Deploy workflow needs
`DATABASE_URL`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`; the daily
membership-expiry job additionally needs `RESEND_API_KEY` and `INVITE_FROM_EMAIL`.
Keep the secret names identical to the variable names above — the provisioner
mirrors `.env.local` into Actions secrets by name, so a CI-only alias (there was a
`PRODUCTION_DATABASE_URL` here) is a secret nothing can ever populate.

## Database migrations

Migrations are plain SQL files in [`migrations/`](../migrations), applied by
[`scripts/migrate.mjs`](../scripts/migrate.mjs):

```bash
npm run migrate          # uses DATABASE_URL
```

The runner records applied files in a `schema_migrations` table and skips them on
re-run, so it is **idempotent** — safe against both a **fresh** database (creates
everything) and an **existing** one (applies only new migrations). This is why it
can run automatically on every deploy.

To add a migration, create the next sequentially-numbered file
(`migrations/000N_description.sql`). Never edit or re-number an already-applied
file; add a new one instead.

## CI (`.github/workflows/ci.yml`)

On every push/PR, CI spins up a `postgres:16` service and:

1. `npm ci` + `npm run typecheck`
2. `npm run migrate` against a **fresh** DB, then **again** to prove idempotency
   against an existing DB
3. `npm run build`
4. `npm test` — the RLS isolation smoke tests gate the build; if tenant/member
   isolation regresses, CI fails.

## Deploy (`.github/workflows/deploy.yml`)

On push to `main`: install deps → **run migrations against the production
database** → deploy to Vercel production. Migrations therefore always run before
the new build serves traffic.

## Local development

```bash
cp .env.example .env        # fill in DATABASE_URL (a local Postgres 16)
npm install
npm run migrate
npm run dev                 # http://localhost:3000
```

## Email deliverability (Resend) — beta-hardening-002

Invite emails are sent through Resend (`lib/email/resend.ts`). For mail to reach
real inboxes — not spam folders — the sending domain must be **authenticated**
with SPF and DKIM, and bounces/complaints must be processed.

### 1. Verified sending domain + SPF / DKIM / DMARC

In the Resend dashboard, add and **verify** the sending domain (e.g.
`mail.yourgym.example`) in the **EU region**, then publish the DNS records Resend
generates. `INVITE_FROM_EMAIL` must use this verified domain — never the shared
`onboarding@resend.dev` sandbox address, which cannot pass DKIM for our domain.

Typical records (Resend shows the exact values for your domain):

| Type | Host | Value | Purpose |
| --- | --- | --- | --- |
| `TXT` | `send.mail.yourgym.example` | `v=spf1 include:amazonses.com ~all` | **SPF** — authorises Resend's MTAs to send for the domain. |
| `TXT` | `resend._domainkey.mail.yourgym.example` | `p=MIGfMA0…` (Resend-provided key) | **DKIM** — signs each message so receivers verify it wasn't altered/forged. |
| `MX`  | `send.mail.yourgym.example` | `feedback-smtp.eu-west-1.amazonses.com` (priority 10) | Return-path / bounce handling for the verified subdomain. |
| `TXT` | `_dmarc.yourgym.example` | `v=DMARC1; p=quarantine; rua=mailto:dmarc@yourgym.example` | **DMARC** — aligns SPF/DKIM and tells receivers what to do on failure; also yields aggregate reports. |

Verification is **DNS/domain config, not code** — the app only references the
verified domain via `INVITE_FROM_EMAIL`.

### 2. Bounce & complaint handling (inbound webhook)

Add a webhook in the Resend dashboard pointing at:

```
https://app.yourdomain.eu/api/email/webhook
```

Subscribe it to `email.bounced`, `email.complained`, `email.delivery_delayed`,
`email.delivered`, and `email.sent`. Copy the webhook's signing secret into
`RESEND_WEBHOOK_SECRET`. The route (`app/api/email/webhook/route.ts`):

- **verifies the Svix signature** over the raw body (rejects spoofed events 401),
- correlates the event to the invite by the Resend message id stored at send time
  (`invite.resend_message_id`, migration `0007`),
- advances `invite.delivery_status` (`sent` → `delivered`, or terminal
  `bounced` / `complained` / `failed`) and stores the reason in
  `delivery_detail`,
- logs every event and raises a **critical alert** (via `captureException`) on a
  bounce/complaint so the team can react before sender reputation degrades.

Staff see a red "Bounced / Marked as spam / Delivery failed" flag on the affected
invite in **Dashboard → Invites**. A synchronous send failure (bad config,
provider rejection) rolls the invite back, surfaces an error to the staff member,
and also raises a critical alert.

### 3. Verifying deliverability against common inbox providers

Use the dev send script to send to real inboxes and confirm authentication:

```bash
node scripts/send-test-email.mjs you@gmail.com
node scripts/send-test-email.mjs you@outlook.com
node scripts/send-test-email.mjs you@yahoo.com
```

In each inbox, open **Show original / View source** and confirm `SPF=pass`,
`DKIM=pass`, and `DMARC=pass`. Gmail's *Show original* and
[mail-tester.com](https://www.mail-tester.com) both report all three at a glance.

## Observability (beta-hardening-001)

- **Structured logs** — every server log is one JSON line (`lib/observability/logger.ts`),
  emitted to stdout/stderr and indexed by Vercel's log drain. Sensitive keys are
  redacted before serialisation.
- **Error monitoring** — uncaught server errors (`instrumentation.ts`
  `onRequestError`), client render errors (the `error.tsx` boundaries →
  `/api/observability/report`), and handled failures all flow through
  `captureException`, which logs + POSTs to `MONITORING_WEBHOOK_URL` if set.
- **Critical alerts** — `critical` severity additionally POSTs to
  `ALERT_WEBHOOK_URL` (e.g. a Slack/PagerDuty webhook), falling back to the
  monitoring URL flagged `alert: true`. Invite send failures and email
  bounces/complaints are raised at this level.
- Users only ever see a friendly message plus a correlation id; stack traces stay
  server-side.

Health check: `GET /api/health` returns
`{ ok, status, db, db_latency_ms, email, time }` — plus `db_error` when the
database is down — and **HTTP 503 when the database is unreachable** (200 when
healthy) so uptime monitors alert on a real outage. Point an uptime monitor at it.

The probe answers within `HEALTH_DB_TIMEOUT_MS` (default 3s) even when Postgres
is completely unreachable, and the pool-level bounds in `.env.example`
(`DB_CONNECT_TIMEOUT_MS` and friends) apply the same discipline to every request
path. This matters more than it looks: without a connect bound, `pg` inherits the
OS TCP timeout (~21s on Windows, up to ~130s on Linux), so a paused Supabase
project or a missing egress rule makes every DB-backed route hang silently
instead of erroring — users get a blank tab, no error boundary renders, and a
monitor times out with no body, which reads as *crashed* rather than *degraded*.
Keep `HEALTH_DB_TIMEOUT_MS` comfortably below your monitor's own timeout.
