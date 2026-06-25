---
name: prod-migrations-via-deploy-workflow
description: Production schema is migrated only by the deploy workflow; boot-time auto-migrate does not run reliably on Vercel
metadata:
  type: project
---

Production (Supabase EU) schema migrations are applied by the GitHub Actions
**deploy** workflow's "Run database migrations (production)" step
(`.github/workflows/deploy.yml`), NOT by the instrumentation `register()`
auto-migrate-on-boot (which spawns `scripts/migrate.mjs` as a child process — that
does not run reliably on Vercel's serverless runtime).

**Incident (2026-06-25):** the Members and Exercises dashboard tabs threw the
generic error boundary ("Something went wrong … team notified") in prod. Root
cause: migrations `0008_workout_logs`, `0009_exercise_library_content`,
`0010_exercise_library_seed_unique` were never applied to prod, so `workout_log`
(joined by the roster query) and the exercise_library content columns
(image_url/instructions/etc., selected by the exercises page) did not exist. They
were never applied because **both `deploy.yml` and `ci.yml` triggered on
`push: branches: [main]`, but the repo's default branch is `master`** — so the
workflows never ran on any push. Fixed by changing both triggers to
`[master, main]`, then applying the pending migrations + catalog seed manually.

**Why:** a branch-trigger mismatch silently disables CI gating AND prod
migration delivery, letting the live schema fall behind the code with no signal.
**How to apply:** after adding a migration, verify it reached prod — query
`select id from schema_migrations` against `DATABASE_URL` (a read-only
introspection query is safe; see [[test-db-points-at-production]]). Keep the
workflow `branches:` list in sync with the repo's default branch.
