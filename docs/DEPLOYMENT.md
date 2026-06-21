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
| `RESEND_API_KEY` / `INVITE_FROM_EMAIL` | Vercel (server-only) | Invite email (used in later tasks). |

In CI/CD these live in GitHub repository **secrets** (`PRODUCTION_DATABASE_URL`,
`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`).

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

Health check: `GET /api/health` returns `{ status, db, ... }` for deploy smoke
tests and uptime monitoring.
