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
| `LOGIN_THROTTLE_WINDOW_MS` / `LOGIN_THROTTLE_IP_ATTEMPTS` / `LOGIN_THROTTLE_ACCOUNT_ATTEMPTS` | Vercel (server-only) | Optional. Sign-in brute-force limits (see Sign-in throttle). |

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

## Deploy — `npm run deploy`

**`npm run deploy` ([`scripts/deploy.mjs`](../scripts/deploy.mjs)) is the deploy
path. `git push` does not deploy anything.** That is not a preference, it is the
current state of the two automated paths — both verified, not assumed:

- **GitHub Actions cannot run.** Every workflow on this repo (Deploy, CI, the
  scheduled expiry job) fails in 4–13s with the annotation *"The job was not
  started because recent account payments have failed or your spending limit needs
  to be increased."* All four deploy secrets (`DATABASE_URL`, `VERCEL_TOKEN`,
  `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`) are present and correct — the jobs simply
  never start. A red Deploy run currently tells you nothing about the code.
- **Vercel's Git integration cannot cover for it.** The Vercel project has no Git
  link at all (`GET /v9/projects/gym-crm-programs` → `link: undefined`), so a push
  to GitHub reaches Vercel by no route. `vercel.json` also sets
  `git.deploymentEnabled.master/main = false`, which is belt-and-braces rather
  than the cause.

Consequence, and the reason this section is emphatic: pushing to `master` moves
nothing live, silently. A correct, pushed, reviewed fix stays invisible until
somebody runs the CLI, which is how "built but not live" was reported round after
round against features that were already implemented.

```bash
export VERCEL_TOKEN=...        # or `npx vercel login` once
npm run deploy
```

What it does, in order:

1. **Refuses to deploy an unpushed or dirty checkout.** "Push and redeploy" is two
   steps and the first is the one that gets skipped; a production build made from
   local-only commits cannot be reviewed or reverted, and leaves the live app
   *ahead* of `master`. Override with `DEPLOY_ALLOW_DIRTY=1` for a hotfix.
2. **Runs migrations before the new build serves traffic** when
   `MIGRATE_DATABASE_URL`/`DATABASE_URL` is set locally. When it is not, the
   deploy still proceeds: `instrumentation.ts` applies pending migrations in the
   deployed process before its first request and `DATABASE_URL` is configured on
   the Vercel project, so the ordering holds either way. Requiring production DB
   credentials on a laptop would make the only working path unusable.
3. `npx vercel@latest deploy --prod` — the same command `deploy.yml` uses, so the
   two paths cannot drift.
4. **Verifies the live URL, and fails the deploy if it is not serving the new
   code.** This is the step that closes the defect. It waits for
   `/api/health`'s `instance.build_id` to change (proving the production alias
   actually moved onto the new build — a successful build that nothing was
   aliased to is the exact failure mode), then requires `/`, `/login` and
   `/portal/login` to each return 200 **and contain their rendered heading**. A
   status alone is not evidence: Next.js serves error boundaries and `not-found`
   shells with cheerful statuses, so a bare 200 check would sign off on an
   unreachable product. A degraded `/api/health` warns but does not fail a deploy
   whose pages all render — including `auth: "unconfigured"`, which is worth
   reading carefully when it appears: the login pages are static, so a deployment
   missing `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   renders them perfectly and then rejects every credential, leaving the whole
   dashboard and portal unreachable behind a page that looks fine. It warns
   rather than fails because a missing project env var cannot be fixed *by* a
   deploy, so blocking on it would only block the deploy carrying the fix.
5. **Signs in for real, and fails the deploy if nobody can.** Step 4 proves the
   pages are *there*; this proves there is a way *past* them. It runs
   [`e2e/live/staff-login.spec.ts`](../e2e/live/staff-login.spec.ts) in a real
   browser against the production URL: `/login` → submit the seeded staff
   credentials → land on `/dashboard` with both session cookies set → follow a
   second guarded route → log out. That closes the one shape of "built but not
   live" a route check cannot see, because `auth: "configured"` above only means
   two variables are *non-empty* — it cannot tell a working key from a rotated
   one, or a seeded database from an empty one. Skipped with a warning (never
   failed) when Playwright is not installed, so `deploy.mjs` stays runnable from a
   production install. Override with `DEPLOY_SKIP_SIGNIN_CHECK=1` when the deploy
   *is* the fix for a broken environment.
6. **Verifies the authenticated member portal** by running `npm run smoke:portal`
   (see below). Step 5 signs in as *staff*; this is the members' half, which no
   static route check can see at all — a deployment whose portal is broken renders
   every page in step 4 flawlessly. Both checks run: a deployment can pass either
   one and fail the other.

Useful overrides: `DEPLOY_VERIFY_URL` (default `APP_BASE_URL`, else
`https://gym-crm-programs.vercel.app`), `DEPLOY_VERIFY_TIMEOUT_MS` (default 180s),
`DEPLOY_SKIP_MIGRATE`, `DEPLOY_SKIP_SIGNIN_CHECK`, `DEPLOY_VERCEL_PKG`.

### Verifying a running deployment on its own — `npm run verify:live`

The same sign-in journey, runnable any time without deploying — the quickest way
to answer "is staff login actually working in production?" with evidence:

```bash
npm run verify:live                                   # production
VERIFY_BASE_URL=https://preview-xyz.vercel.app npm run verify:live
```

It starts no servers and needs no database or secrets — it drives the public
sign-in path exactly as a visitor does. Credentials come from
[`lib/demo-accounts.ts`](../lib/demo-accounts.ts) (the list the forms themselves
advertise, pinned against `scripts/seed.mjs` by `test/demo-accounts.test.ts`);
override with `VERIFY_STAFF_EMAIL`/`VERIFY_STAFF_PASSWORD` where the `SEED_*`
defaults were changed. It deliberately has **no wrong-password case** — sign-in is
throttled at 6 attempts per account per 5 minutes, so a negative control would
park the demo account in a lockout for the next visitor; that path is covered
locally in `e2e/invite-flow.spec.ts` instead.

## Verifying the member portal — `npm run smoke:portal`

```bash
npm run smoke:portal                          # defaults to production
npm run smoke:portal -- --base http://localhost:3000
```

[`scripts/smoke-portal.mjs`](../scripts/smoke-portal.mjs) signs a demo member in
at `/portal/login` with a real browser and asserts the portal actually renders
**upcoming bookings/classes, membership status and payment history**.

**Why it exists.** The member portal was reported as *"built but not live — the
code implements this but the running app doesn't serve it"* round after round,
every time incorrectly. Nothing could cheaply disprove it, because every
automated check stopped at the front door: `/`, `/login` and `/portal/login` are
static, prerendered, database-free pages that render perfectly on a deployment
whose portal is broken, whose database is unreachable, or that was never seeded.
`e2e/invite-flow.spec.ts` *does* cover the authenticated portal, but it needs a
local throwaway Postgres plus the GoTrue stub, so it skips outside CI — and CI
cannot run at all (see the billing block above). Answering "does a member
actually see their bookings?" therefore meant hand-driving a browser. Now it is
one command, and step 5 of every deploy.

It needs no database and no Supabase keys: the credentials are the seed's public
demo member, read from the same `SEED_MEMBER_EMAIL`/`SEED_MEMBER_PASSWORD` that
`scripts/seed.mjs` uses, so a deployment seeded with overridden credentials is
verifiable with no extra configuration. Exit codes are meaningful, and
`deploy.mjs` relies on the distinction:

| Exit | Meaning | Effect on a deploy |
| --- | --- | --- |
| 0 | The portal is live and every section rendered. | passes |
| 1 | Signed in, but the portal did not serve — a defect in the shipped code. | **fails** |
| 2 | Cannot run: no Playwright/browser, or no seeded demo member on that deployment. | warns |

Exit 2 only warns for the same reason `auth: "unconfigured"` does — neither cause
is created or fixable *by* the deploy, so failing would just block the deploy
carrying the fix. Requires dev dependencies and `npx playwright install chromium`.

### `.github/workflows/deploy.yml`

Kept and correct — install deps → migrate the production database → deploy to
Vercel production, so migrations always precede live traffic. It triggers on push
to `master`/`main` and will resume working the moment the Actions billing block is
lifted, at which point it becomes the primary path again and `npm run deploy`
stays available for manual releases. **Until then it never starts**, so do not
read its status as a deploy gate.

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

Use the send script to send to real inboxes and confirm authentication:

```bash
node scripts/send-test-email.mjs you@gmail.com
node scripts/send-test-email.mjs you@outlook.com
node scripts/send-test-email.mjs you@yahoo.com
```

It sends, then **polls `GET /emails/{id}` until Resend reports a terminal state**,
and exits non-zero unless the message was `delivered`. That distinction is the
point: a 200 from `POST /emails` only means Resend accepted the message, and a
domain with a broken DKIM record, a suppressed recipient, or an IP the receiver
rejects all produce a clean 200 and then fail silently. Add `--no-wait` for the
old accept-only behaviour.

For unattended runs (a cron, a deploy hook) set `VERIFY_EMAIL_TO` and use
`npm run verify:email`; `VERIFY_EMAIL_TIMEOUT_MS` bounds the wait (default 60s).

Delivery still does not prove authentication, so in each inbox open
**Show original / View source** and confirm `SPF=pass`, `DKIM=pass`, and
`DMARC=pass`. Gmail's *Show original* and
[mail-tester.com](https://www.mail-tester.com) both report all three at a glance.

`npm run verify:live` additionally asserts that the running deployment still
reports every capability as configured (`e2e/live/capabilities.spec.ts`) — it
catches a rotated or dropped `RESEND_API_KEY` without sending anything, but for
the same reason cannot speak to deliverability.

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
- **Sign-in failures are reported too** — the two login Server Actions used to
  turn *every* failure into the same friendly string and tell nobody, so a
  deployment where authentication was completely broken looked exactly like one
  where someone mistyped a password. They now classify the failure
  (`AuthFailureKind` in `lib/auth/supabase.ts`) and report the ones that mean
  nobody can sign in: an unusable auth service (unreachable / timing out /
  unconfigured / not returning a session), and — as `critical` — an access token
  this deployment cannot verify, which is a 100% login failure even with the
  correct password. A rejected password is deliberately *not* reported.
- Users only ever see a friendly message plus a correlation id; stack traces stay
  server-side.

## Sign-in throttle (beta-hardening-002)

`/login` and `/portal/login` rate-limit password submissions before any call to
the auth service (`lib/auth/login-throttle.ts` over `lib/rate-limit.ts`). Two
buckets must both pass, because they stop different attacks: **per IP** (one host
walking a password list) and **per account** (credential stuffing for one address
from many hosts, which a per-IP counter cannot see). Defaults are 10 attempts per
IP and 6 per account per 5-minute rolling window; a successful sign-in clears both.
Refusals are logged as `sign-in attempt throttled` with the scope and rate — but
never the address or IP, both of which are personal data.

Tuning and the single-instance caveat (counters are per server instance, so the
effective global limit is instances × the value) are documented on the
`LOGIN_THROTTLE_*` variables in [`.env.example`](../.env.example).

Health check: `GET /api/health` returns
`{ ok, status, db, db_latency_ms, email, auth, time }` — plus `db_error` when the
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
