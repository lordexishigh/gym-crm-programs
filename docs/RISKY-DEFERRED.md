# Applied vs. left-behind — review for the product owner

> **Date:** 2026-06-25
> **Context:** You asked me to apply my suggestions and *"leave behind anything
> you feel is risky, mention it and point me to the file so I can review."* This
> is that note. The suggestions themselves live in `docs/PLAN.md` (the
> **v1-hardening** phase) and `docs/CRM-IDEAS.md` (the "Apply now" list).

---

## ✅ Applied now (safe, tested)

### 1. Roster engagement signal — "who went quiet?"
The members roster now shows an at-a-glance **Active / Inactive** badge per
member, so a trainer spots disengaged members without opening each profile. This
was the review's single biggest daily-value gap.

- **Files:** `app/dashboard/members/page.tsx` (badge + query wiring),
  `lib/members.ts` (`rosterListSql`, `RosterMemberRow`),
  `lib/workout-logs.ts` (`memberEngagementLevel`, `RosterEngagement`),
  `test/roster-engagement-view.test.ts` (new).
- **Why it's safe:** no schema change — it reads the existing `workout_log`
  table, which already has staff read-only RLS (`workout_log_staff_select`). The
  engagement counts come from a **single aggregate join** (no N+1), and search /
  filter / pagination are unchanged. Type-check passes; full suite green
  (137 passed, DB suites skip locally — see below).

### Already done before this pass
- **Live dashboard overview cards** (`review-hardening-dashboard-001`) were
  already implemented in `app/dashboard/page.tsx` (live tenant-scoped counts +
  navigable cards). I ticked it in `docs/PLAN.md` and noted the one remaining
  loose end: there's no dedicated data-test for the counts yet (low risk — the
  counts are RLS-scoped by construction).

---

## ⚠️ Left behind — please review before I proceed

### A. Renumbering the three `0003_*` migration files — **DO NOT apply blindly**
`review-hardening-migrations-001` asks to renumber the three files that share the
`0003` prefix so ordering is unambiguous.

- **Files:** `migrations/0003_assignment_lifecycle.sql`,
  `migrations/0003_library_and_templates.sql`,
  `migrations/0003_member_extended_fields.sql`, and the runner
  `scripts/migrate.mjs`.
- **Why it's risky:** the migration runner records each *applied filename* in a
  `schema_migrations` table. Your **production** database already has the three
  `0003_*.sql` filenames recorded. If I rename them, the runner sees the new
  names as "never applied" and **re-runs them against production** on the next
  deploy. They're mostly idempotent (`create ... if not exists`), but re-running
  schema DDL against a live DB is exactly the kind of thing that should be done
  deliberately, with a one-off backfill of the `schema_migrations` rows — not
  silently inside an unrelated change.
- **Recommendation:** safe to do, but as its own change with a tested backfill
  step (insert the new filenames into `schema_migrations` for any DB where the
  old ones are already recorded) — ideally run by you against the DB console.
  Today nothing is broken: the three files are independent, so the current
  alphabetised order is harmless.

### B. Per-exercise set logging — large, cross-cutting, can't verify locally
`review-hardening-set-logging-001` (the #2 "greenlit" idea) — let members log
actual sets/reps/weight per exercise, not just a session-level note.

- **Files it would touch:** a new `migrations/0009_*.sql` (new `workout_set`
  table + RLS policies), `lib/workout-logs.ts` (a new pure `validate*Input`),
  `app/portal/LogWorkout.tsx` + `app/portal/actions.ts` (dynamic per-exercise
  form), `app/portal/WorkoutHistory.tsx` (roll-up display),
  **and the GDPR/retention surfaces** it must not leave a hole in:
  `lib/gdpr/export.ts` (include per-set data in the export),
  `lib/gdpr/export.ts` erasure path (scrub on member erasure),
  `docs/DATA_RETENTION.md`, plus the auto-discovery isolation test
  (`test/isolation-coverage.test.ts`) which fails CI for any new tenanted table
  missing RLS.
- **Why I left it:** it spans the write path, RLS, GDPR export **and** erasure,
  and retention at once — a half-done version is *worse* than none (e.g. set
  data that erasure forgets to scrub = a GDPR gap). I can't run the DB-backed
  RLS/GDPR tests locally to prove it (see below), so I'd rather land it as its
  own focused, fully-tested change than ship it unverified here.
- **Recommendation:** greenlight it as the next single task; it's well-scoped and
  high value, just bigger than a "leave behind anything risky" pass should
  swallow.

---

## Why the database tests skip locally (related, worth knowing)
The repo's `.env` / `.env.local` point `DATABASE_URL` at the **live production**
Supabase database. A safety guard (`test/setup/db-safety.ts`, and
`memory/test-db-points-at-production.md`) deliberately blanks a non-local
`DATABASE_URL` so the seeding RLS tests can't ever hit production by accident —
so those suites **skip** on this machine and run only in CI (which uses a
throwaway Postgres). This is also why I did not run any migration against the DB
during this change.
