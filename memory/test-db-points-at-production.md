---
name: test-db-points-at-production
description: Repo .env DATABASE_URL is PRODUCTION Supabase; tests are guarded but the flag can override
metadata:
  type: project
---

The repo's `.env` sets `DATABASE_URL` (and `MIGRATE_DATABASE_URL`) to the **live
production** Supabase Postgres (EU pooler). `scripts/migrate.mjs` does
`import "dotenv/config"`, so any DB-backed test (which imports it) loads that URL.
Running `npm test` locally used to silently SEED production — the
`isolation-comprehensive` suite created `Audit Gym A`/`Audit Gym B` fixture trees
there (found 16 such rows from repeated runs).

**Guard now in place:** `test/setup/db-safety.ts` (vitest `setupFile`) blanks a
non-local `DATABASE_URL` so DB suites SKIP unless the host is local OR
`ALLOW_NONLOCAL_TEST_DB=1` is set. CI is unaffected (it overrides `DATABASE_URL`
to a throwaway local Postgres).

**Observed pollution (2026-06-25):** prod already holds many fixture-gym rows from
past runs — `Gym A/B`, `Audit Gym A/B`, `Erase Gym A/Idem/Staff/X/Y`,
`Export Gym A/B`, `Lib Gym A/B`, `Lifecycle Gym A/B`, `Portal Gym A/B`,
`Prog Gym A/B` — each with a seeded `exercise_library`. The genuine prod tenant is
`Demo Gym` (slug `demo-gym`, the seed default). Cleaning these is destructive — get
explicit owner sign-off before deleting (`delete from gym where name in (...)`,
children cascade).

**Why:** prevents destructive/seeding RLS tests from ever hitting prod by accident.
**How to apply:** never set `ALLOW_NONLOCAL_TEST_DB=1` against the prod URL; to run
DB tests locally, point `DATABASE_URL` at a throwaway Postgres. Pre-existing
`Audit Gym A/B` rows clean up via `delete from gym where name in ('Audit Gym A','Audit Gym B');` (children cascade).
