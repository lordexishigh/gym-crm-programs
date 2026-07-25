# Application Review — 2026-06-24

A review of the gym-CRM application across backend, frontend, visuals, UI, and
usability, with concrete strengths and weaknesses tied to specific files. The
review-driven work is scheduled in `docs/PLAN.md` under the **v1-hardening**
phase; small, obviously-correct fixes were applied directly and are listed at
the end.

## Scope

The product is a multi-tenant Next.js (App Router) CRM: trainers author training
programs and assign them to members; invited members read their program on a
mobile portal and (as of Phase GA) log completed workouts. Isolation is enforced
at the database by Postgres Row Level Security.

---

## Backend

### Strengths

- **RLS-first isolation is the real security boundary, not application code.**
  `migrations/0002_rls_policies.sql` enables *and* `FORCE`s RLS on every tenanted
  table and derives identity from transaction-local GUCs
  (`app.tenant_id` / `app.role` / `app.member_id`). `lib/db.ts`
  (`withTenantContext`) sets those GUCs from the server-verified identity and
  then `SET LOCAL ROLE app_user` — a non-owner, non-superuser role — so even a
  query that forgets `WHERE tenant_id = …` cannot cross tenants. GUCs are
  transaction-local, so a pooled connection never leaks identity to the next
  request.
- **Identity is never trusted from the browser.** `lib/identity.ts` verifies a
  Supabase-issued JWT against the project JWKS (asymmetric ES256, no shared
  secret stored) and reads custom claims from `app_metadata`. `tenant_id` and
  `member_id` come only from the verified token.
- **Validation is pure and shared.** `lib/workout-logs.ts`,
  `lib/programs.ts`, and `lib/exercise-library.ts` expose pure
  `validate*Input` functions (no DB, no env) that run in the Server Action
  before any round-trip and are unit-tested in isolation. The DB still enforces
  the hard invariants (CHECKs, composite `(id, tenant_id)` FKs).
- **Shared SQL constants prevent page/test drift.** `RECENT_WORKOUTS_SQL` and
  `MEMBER_ADHERENCE_SQL` (`lib/workout-logs.ts`), `MEMBER_STATUS_HISTORY_SQL`
  (`lib/member-records.ts`), and `EXPIRE_STALE_INVITES_SQL`
  (`lib/invite-status.ts`) are defined once and reused by both the page and its
  test, so the verified path and the served path cannot diverge.
- **The first member-written path is correctly minimal.**
  `app/portal/actions.ts` (`logWorkoutAction`) takes the member id from the
  verified session, never the form; RLS rejects a log for anyone else or against
  an unassigned program (`workout_log_member_*`, migration 0008). The action
  validates first for a friendly message, then relies on RLS as the boundary.
- **Lazy invite-expiry sweep is wired in.** `expireStalePendingInvites`
  (`lib/invite-status.ts`) is invoked before reading invite status in both
  `app/dashboard/invites/page.tsx:23` and `app/dashboard/members/[id]/page.tsx:51`,
  so the stored `expired` status is corrected eagerly, not only at display time
  via `effectiveInviteStatus`.

### Weaknesses

- **Duplicate migration numbers.** Three files share the `0003` prefix:
  `0003_assignment_lifecycle.sql`, `0003_library_and_templates.sql`, and
  `0003_member_extended_fields.sql`. `scripts/migrate.mjs:42` orders by filename
  (`readdirSync(...).sort()`), so the applied order is deterministic but is
  decided by alphabetized *suffixes* rather than intent. Today the three are
  independent so nothing breaks, but the scheme is fragile: a future `0003_*`
  that depends on another would silently apply in the wrong order. Tracked as
  **v1-hardening** (`review-hardening-migrations-001`).
- **No roster-level engagement signal.** The member detail page surfaces
  adherence (`WorkoutAdherence`), but the roster query
  (`app/dashboard/members/page.tsx`) returns no logging data, so a trainer must
  open each member individually to see who has gone quiet. This is exactly the
  still-open `ga-trainer-insights-002`, carried forward below.
- **Workout logging stops at the session level.** `ga-engagement-002`
  (per-exercise actual sets/reps/weight) is unimplemented; a logged session
  records only program, effort, and a note (`lib/workout-logs.ts`
  `WorkoutLogInput`). Carried forward below.

---

## Frontend & UI

### Strengths

- **Server Components + Server Actions throughout**, with `export const dynamic =
  "force-dynamic"` on pages that must reflect live tenant data
  (`members/page.tsx`, `invites/page.tsx`, `members/[id]/page.tsx`).
- **Roster state lives in the URL.** `app/dashboard/members/page.tsx` uses a
  plain GET form for search/filter/pagination, so views are shareable and
  back-button friendly, and the query re-runs server-side and tenant-scoped.
- **Presentational components are session- and DB-free.** `WorkoutAdherence`,
  `StatusHistory`, and `ProgramHistory` take already-fetched, RLS-scoped data as
  props (the page owns the read), keeping them unit-testable.

### Weaknesses

- **The dashboard overview is a non-functional stub.**
  `app/dashboard/page.tsx` rendered three `<div>` "cards" that are not links and
  carry no real data, and printed the raw tenant UUID to the screen
  (`Signed in to tenant …`) — a usability wart and a minor information leak.
  Partially fixed now (see Applied improvements); live counts are deferred to
  `review-hardening-dashboard-001`.

---

## Visuals

### Strengths

- **The dark theme is centralised and contrast-reasoned.**
  `app/globals.css` declares `color-scheme: dark`, defines the brand accent as
  space-separated RGB channels in one place, and remaps bright neutral surfaces
  (`.bg-white`, `.bg-slate-50/100`) and the text/border tones that sat on them to
  dark equivalents — so the app was recoloured without touching every component.
  The brand is deliberately split (`--brand` solid fill vs `--brand-text` accent
  text) with documented WCAG AA contrast ratios, and there is a single app-wide
  `:focus-visible` ring plus a `prefers-reduced-motion` reset.

### Weaknesses

- **The global surface remap relies on `!important` overrides keyed to specific
  utility classes** (`app/globals.css`). It works, but a new component that uses
  a neutral shade not in the override list (e.g. `bg-slate-200`) would render a
  bright surface on the dark theme. This is a known trade-off of the "recolour
  without touching components" approach, not a regression; noted for awareness,
  not scheduled.

---

## Usability

### Strengths

- Friendly, member-facing validation messages (`"Choose which program you
  trained."`, `lib/workout-logs.ts`) instead of raw constraint errors.
- Empty and stale states are handled explicitly (`WorkoutAdherence` shows a "may
  have stopped training" banner and a no-workouts-yet message; the roster shows
  distinct empty states for "no members" vs "no match").

### Weaknesses

- The lack of a roster-level engagement indicator (above) is also the biggest
  usability gap for the trainer's daily loop: spotting disengaged members
  currently requires drilling into each profile.

---

## Applied improvements (this change)

- **`app/dashboard/page.tsx`**: made the three overview cards real navigable
  links to their sections and removed the raw tenant-UUID line. Low-risk,
  obviously-correct UI fix; live counts on the cards are deferred to
  `review-hardening-dashboard-001`.

## Deferred improvements (scheduled in `docs/PLAN.md` → v1-hardening)

The substantive items are intentionally **deferred** rather than rushed into
this review, and are scheduled as numbered tasks under the new **v1-hardening**
phase:

- Roster engagement indicators (carries forward `ga-trainer-insights-002`).
- Per-exercise set logging (carries forward `ga-engagement-002`).
- Live, navigable dashboard overview.
- Resolve duplicate `0003` migration numbering.

## 2026-07-25 — GDPR erasure bug fix + next steps

**Bug found and fixed this pass:** `anonymiseMember` (`lib/gdpr/export.ts`,
beta-gdpr-002) scrubs a member's `workout_log.note` on erasure, but
`app_user` was never granted `UPDATE` on `workout_log` — migration 0008
deliberately grants only `select, insert, delete` ("a log is immutable once
written"). Postgres checks table-level UPDATE privilege before the `WHERE`
clause runs, so **every** erasure request hit
`permission denied for table workout_log` and failed outright, regardless of
whether the member had any logs. Right-to-erasure has been broken since the
GDPR feature shipped; DB-backed tests skip on developer machines by design
(production `DATABASE_URL` guard, see `test/setup/db-safety.ts`), so this
only surfaces where a real Postgres runs the suite. Fixed by
`migrations/0014_workout_log_erasure_grant.sql`: a narrow
`grant update (note) on workout_log to app_user` plus a staff-only,
tenant-scoped RLS policy — logs stay immutable in every other respect.
Regression coverage added in `test/workout-logs-rls.test.ts`.

Since local DB-backed tests are normally skipped (the production `.env` guard
above), it's worth periodically running the suite against a real throwaway
Postgres locally (`npm run migrate && npm test` with `DATABASE_URL` pointed at
a local instance) rather than relying solely on CI, to catch this class of
grant/RLS-policy drift earlier.

**Next steps (not yet done, worth picking up):**

- Land the roster-level engagement badge → GDPR export path check: confirm no
  other write path added since beta-gdpr-002 shipped has the same
  missing-grant shape (e.g. any future member-written table needs its erasure
  scrub path's grants added in the SAME migration as the scrub code, not
  assumed from the table's original grant).
- CRM-IDEAS "Apply now" #5 (trainer follow-up tasks / reminders on a member)
  is still open — a good next single-PR pick once this fix lands.
