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
`migrations/0018_workout_log_erasure_grant.sql`: a narrow
`grant update (note) on workout_log to app_user` plus a staff-only,
tenant-scoped RLS policy — logs stay immutable in every other respect.
Regression coverage added in `test/workout-logs-rls.test.ts`.

> Numbering note (2026-08-13): this branch originally carried the fix as
> `0014_workout_log_erasure_grant.sql`. While it sat open the same fix landed on
> master as **0018**, and `0014` was taken by `0014_membership_plans.sql`. The
> duplicate migration was therefore dropped when rebasing — re-adding it would
> have collided with an applied prefix and re-run DDL (see
> `test/migration-filenames.test.ts`). **The tests below are what this branch
> still contributes**: 0018 shipped with no RLS coverage proving the note-only
> grant is actually column- and tenant-scoped.

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

**Update (2026-08-04+):** both of the above are done. #5 shipped as
`auto-improve: trainer follow-up tasks / reminders on a member` (`member_task`,
migration `0025`). The grant-audit check was done too: that PR's own erasure
scrub (`anonymiseMember` scrubbing `member_task.title`) explicitly notes
`member_task_staff_all` already grants staff full UPDATE, so — unlike
`workout_log` — no separate grant migration was needed. `check_ins` and
`class_bookings` (added since, migrations `0016`/`0022`/`0023`) hold no
free-text PII and need no scrub; both are already included in
`exportMemberData` (`lib/gdpr/export.ts`). No open gap found in this pass.

## 2026-08-16 — CI is not actually running (blocks every open PR and deploy)

**This is the priority finding of this pass — a process/infra gap, not a code
one, and it needs a human decision, not a PR.**

`build-and-test` (`.github/workflows/ci.yml`) is the one required check
gating `master` (branch protection) and deploys (`deploy.yml`'s
`migrate-and-deploy: needs: test`). It has been failing **without ever
starting a runner** since some point between **2026-08-14 06:42 UTC** (the
last run that genuinely executed — master push for #10, run
[31776978152](https://github.com/lordexishigh/gym-crm-programs/actions/runs/31776978152),
which ran the full ~4.5 minute pipeline and failed for a real reason, the
already-tracked #26 e2e flake) and **2026-08-14 22:26 UTC** (PR #39's first
attempt, run
[31846609297](https://github.com/lordexishigh/gym-crm-programs/actions/runs/31846609297),
which failed in **4 seconds** with no job steps recorded and `runner_id: 0` —
GitHub never assigned it a runner at all). Every run since matches that same
signature: PR #38 (5 attempts), PR #39 (1 attempt), PR #40 (4 attempts) — all
complete in 3-4 seconds, all with `runner_id: 0` and no `steps` array, and
`get_job_logs` 404s on every one of them (consistent with a runner that never
started — there is no log stream to fetch). As of this pass (2026-08-16) it
has not recovered on its own for over 24 hours.

This is a **different failure than #26**. #26 is a real, intermittent
in-test hang that still shows a full step-by-step run reaching the e2e job
and then failing there (see the two runs above it, and #26 itself). What's
happening now never reaches a runner at all — the shape this repo's own
`ci.yml` comment already names and warns about: *"Rebasing the open PRs in
one go therefore started ~11 simultaneous full runs and exhausted the
account's Actions spending limit, after which GitHub refused to start ANY
job for hours."* The timing (transition right after a dense run of pushes/PRs
on 2026-08-14) and the exact symptom (job created, never scheduled) match
that description, though this pass could not confirm the account's Actions
billing/usage page directly — no tool available here reaches GitHub billing
settings.

**Why this matters:** three PRs are currently stuck and unmergeable through
no fault of their own content (#38 streak-milestone badges, #39 a routine
dependency bump, #40 the current #26 diagnostic step) — the required check
cannot pass no matter what the diff contains. No further PR opened by this
routine (or anyone) can merge until this clears, either.

**Recommended next step (needs a human with repository/org admin access):**
check the GitHub Actions usage/billing page for this account
(Settings → Billing → Plans and usage → Actions, or the org equivalent) for
a spending-limit cap or a suspended state, and raise or clear it. If usage
genuinely got that high, the follow-up worth a separate ticket is trimming
this workflow's cost — `test:e2e` alone runs a full Chromium install plus two
Playwright journeys against a fresh Postgres + Next.js build on every push
and every retry, and #26 has driven a lot of retries lately.

Not fixed in this pass: there is nothing in this repository to fix — the
gap is external (GitHub account configuration), and every retry against it
so far has cost more of the same limited resource without changing the
outcome. No further diagnostic PRs for #26 should be opened until a run can
actually reach the e2e step again; the four already open/queued (#38/#39/#40
and any future one) will simply resume being evaluated once CI starts
scheduling runners again — no rebase or re-push needed.

## 2026-08-20 — the Actions outage ended; the red CI on `master` is now real

Correcting the 2026-08-16 entry above, which is left as written. Its measurement
was right and its conclusion has expired.

**Actions runs again on this repository.** The outage ended between
2026-08-19 09:06 UTC and 18:12 UTC. Evidence, all step-level rather than
conclusion-level:

| run | what executed |
|---|---|
| [32192304370](https://github.com/lordexishigh/gym-crm-programs/actions/runs/32192304370) (`deploy.yml`) | `test` 12 steps green, `migrate-and-deploy` 10 steps green — `master` was deployed |
| [32192304375](https://github.com/lordexishigh/gym-crm-programs/actions/runs/32192304375) (`ci.yml`, attempt 3) | all 23 steps ran; failed at *End-to-end journey tests* |
| [32289534734](https://github.com/lordexishigh/gym-crm-programs/actions/runs/32289534734), [32290230618](https://github.com/lordexishigh/gym-crm-programs/actions/runs/32290230618), [32292232989](https://github.com/lordexishigh/gym-crm-programs/actions/runs/32292232989) | 23 steps each, 2 failed / 13 passed in Playwright |

**What that changes: `master` is red for a real reason again.** The two failing
journeys are `invite-flow.spec.ts:131` and `staff-journey.spec.ts:180`, and they
have failed on **every** run since the outage lifted — four for four, across four
different branches. That is [#26](https://github.com/lordexishigh/gym-crm-programs/issues/26),
which was closed on 2026-08-18 by PR #40's body containing the words *"Does not fix
#26"* (GitHub parses `fix #26` regardless of the prose in front of it) and has been
reopened with the evidence. The 2026-08-13 record of "2 pass / 2 fail across four
runs" is superseded: it is now 0 pass / 4 fail.

**What has not changed.** The account-level block is still in force for the private
repositories on this account, and this repo's own scheduled job
(`membership-expiry.yml`) was still refused on its 2026-08-19 attempt. Public
repositories get free minutes; private ones bill against an allowance that is not
paying. So the underlying setting the 2026-08-16 entry asked a human to fix is
**still unfixed** — it merely stopped affecting this repository.

**The reading rule this leaves behind.** An outage-blocked job has **zero** steps,
completes in 3–13s, and carries the annotation *"The job was not started because
recent account payments have failed…"*. Anything with a step list failed for a
reason in the diff. Check which one before writing either off — for five days
every red run here was the former, and the habit that formed made a real failure
easy to dismiss.

