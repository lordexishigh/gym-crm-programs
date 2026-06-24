# Build Plan

## MVP — Deployed as one hosted Next.js application, a trainer at a gym can log in, add a member, build a training program, assign it to that member, and the invited member can log in on their phone and read it — with all data strictly isolated per gym by Postgres RLS.

**Success criteria:**

- The application is deployed to a hosted environment with secrets/JWT signing keys configured and database migrations run automatically.
- tenant_id and user identity are derived server-side from the signed JWT and never trusted from the browser.
- Postgres Row Level Security makes cross-tenant and cross-member reads/writes impossible even with a forged client request, verified by smoke-level isolation tests.
- A trainer can authenticate, create a member, send an invite email via a provisioned transactional email provider, build a program (exercises with sets/reps/rest/notes), and assign it within their tenant.
- An invited member can log in on a mobile browser and see exactly the program assigned to them, and nothing else.

### mvp-platform-foundation — Platform foundation: deployment, DB schema, and RLS tenant isolation

The thin, rock-solid foundation everything builds on. Stand up the Next.js App Router project, deploy it to a hosted environment with secret/JWT-signing-key config and automated database migrations on a basic CI pipeline, define the PostgreSQL 16 schema for the core tenanted models, and write the Row Level Security policies that enforce tenant and member isolation at the DB layer. Includes smoke-level isolation tests so the security keystone is verified from day one.

- **mvp-platform-foundation-001** Bootstrap Next.js App Router project with Tailwind and TypeScript
  - [ ] App builds and serves a responsive landing/login shell.
  - [ ] Tailwind configured with mobile-first breakpoints.
  - [ ] Project structure supports Route Handlers and Server Actions.
- **mvp-platform-foundation-002** Deployment, environment/secret config, and automated migrations with basic CI
  - [ ] The app deploys to a hosted URL from the main branch.
  - [ ] Secrets and JWT signing keys are stored in the environment, not in source.
  - [ ] Database migrations run automatically on deploy against a fresh and an existing database.
  - [ ] Basic CI builds the app and runs the test suite on each change.
- **mvp-platform-foundation-003** Create PostgreSQL 16 schema for core tenanted models
  - [ ] Migration creates all seven core tables with tenant_id columns and FKs.
  - [ ] Indexes exist on tenant_id and on assignment lookup columns.
  - [ ] Schema applies cleanly from a fresh database.
- **mvp-platform-foundation-004** Implement Row Level Security policies for tenant and member isolation
  - [ ] RLS is enabled on every tenanted table.
  - [ ] A query made with gym A's context cannot read or write gym B's rows.
  - [ ] A member's context cannot read another member's rows.
  - [ ] Policies are enforced at the DB layer regardless of application code.
- **mvp-platform-foundation-005** RLS isolation smoke tests
  - [ ] A test asserts a cross-tenant read of another gym's rows returns nothing / is rejected.
  - [ ] A test asserts a cross-member read of another member's program is blocked.
  - [ ] Tests run in CI and fail the build if isolation regresses.

### mvp-auth — Authentication: staff and member login with server-side JWT identity _(depends on: mvp-platform-foundation)_

Own the full identity surface for both audiences. Integrate Supabase Auth so a signed JWT carries user identity and tenant_id, derived server-side on every request. Build the staff sign-in flow and authenticated dashboard shell, and the member portal login/session handling so an invited member can authenticate on a mobile browser. Account *setup* from an invite lives in member-management; this task owns ongoing login and session for both roles.

- **mvp-auth-001** Configure Supabase Auth and server-side JWT identity
  - [ ] A verified JWT yields tenant_id and user id server-side.
  - [ ] No code path accepts tenant_id from the browser/request payload.
  - [ ] Unauthenticated requests to protected routes are rejected.
- **mvp-auth-002** Staff login and dashboard shell
  - [ ] A trainer can log in and reach the dashboard.
  - [ ] Logged-in session resolves to the correct gym tenant.
  - [ ] Logout works and protected pages redirect when unauthenticated.
- **mvp-auth-003** Member portal login and session handling
  - [ ] A set-up member can log into the portal on a mobile browser.
  - [ ] The member session resolves to the correct Member row and gym tenant server-side.
  - [ ] Logout works and portal pages redirect when unauthenticated.

### mvp-member-management — Member records and invite flow _(depends on: mvp-auth)_

Staff can create, view, and edit member records for their gym, and onboard members via an invite email sent through a provisioned transactional email provider (Resend). The invited member accepts the invite and sets up portal access — no public self-signup in v1.

- **mvp-member-management-001** Member CRUD UI and Server Actions
  - [ ] Staff can create, view, and edit a member record.
  - [ ] Member list only shows the current gym's members.
  - [ ] Validation prevents saving incomplete required fields.
- **mvp-member-management-002** Provision transactional email provider integration (Resend)
  - [ ] A server-side helper can send a transactional email via Resend using env-configured credentials.
  - [ ] A test/dev send succeeds end to end to a real inbox.
  - [ ] Send failures return an error the caller can handle rather than crashing the request.
- **mvp-member-management-003** Generate and send invite emails
  - [ ] Creating an invite stores a token-bound Invite row scoped to the gym and member.
  - [ ] An invite email is delivered with a working onboarding link.
  - [ ] Invite tokens are single-use and expirable.
- **mvp-member-management-004** Member invite acceptance and portal account setup
  - [ ] A valid invite token lets the member set up access; an invalid/expired one is rejected.
  - [ ] The new member account is bound to the correct gym tenant and Member row.
  - [ ] After setup the member can authenticate to the portal.

### mvp-program — Program authoring and assignment _(depends on: mvp-member-management)_

The differentiating wedge: a trainer builds a training program composed of exercises (each with sets, reps, rest, and notes) and assigns it to a specific member within their gym, creating a ProgramAssignment the member portal will surface. Authoring and assignment are kept in one cohesive task to respect the MVP task budget.

- **mvp-program-001** Program and exercise data layer
  - [ ] A program with multiple ordered exercises persists and reloads with order preserved.
  - [ ] Each exercise persists its sets, reps, rest, and notes values exactly as entered (verified by reading them back).
  - [ ] Programs and exercises created under gym A are not visible or writable under gym B.
- **mvp-program-002** Program builder UI
  - [ ] A trainer can add, edit, reorder, and remove exercises in a program.
  - [ ] Each exercise field (sets, reps, rest, notes) is captured and shown on reload.
  - [ ] The program saves and reloads accurately, including exercise order.
- **mvp-program-003** Assignment data layer
  - [ ] Assigning a program creates a ProgramAssignment row linking the program and member.
  - [ ] Assignment is rejected server-side if the program and member belong to different gym tenants (a trainer cannot assign to a member outside their tenant).
  - [ ] An existing assignment can be replaced or updated.
- **mvp-program-004** Assignment UI from program or member
  - [ ] A trainer can assign a program to a member from the dashboard.
  - [ ] The member picker only lists the current gym's members.
  - [ ] The current assignment is visible to staff after assigning.

### mvp-member-portal — Member portal (read-only, mobile-first) _(depends on: mvp-program, mvp-auth)_

An invited member logs in on their phone browser and sees the training program assigned to them, rendered read-only and mobile-first. Member login/session is provided by mvp-auth; this task surfaces the assigned program.

- **mvp-member-portal-001** Member-scoped program query
  - [ ] An authenticated member receives only their assigned program.
  - [ ] A member cannot fetch another member's or gym's program even via crafted requests.
  - [ ] Members with no assignment see an appropriate empty state.
- **mvp-member-portal-002** Mobile-first read-only program view
  - [ ] The program renders clearly on a mobile viewport.
  - [ ] All exercise details (sets, reps, rest, notes) are shown.
  - [ ] No editing controls are exposed to the member.

## Alpha — Complete the feature set so the product is usable as a day-to-day CRM, not just a demo loop.

**Success criteria:**

- Staff can search, filter, and manage a full roster of members with complete records.
- Trainers can reuse exercises and program templates rather than authoring from scratch each time.
- A member can have multiple programs over time with visible history; trainers can edit and re-assign.
- Invites can be resent, revoked, and their status tracked.

### alpha-member-records — Full member records, search, and filtering _(depends on: mvp-member-management)_

Round out the generic CRM table stakes: richer member fields (contact, status, notes), a searchable and filterable roster, and bulk-friendly list views.

- **alpha-member-records-001** Extended member fields and detail view
  - [ ] Staff can capture extended member fields.
  - [ ] Member detail view shows all fields and edit history of status.
  - [ ] Validation handles optional vs required fields.
- **alpha-member-records-002** Roster search and filtering
  - [ ] Staff can search members by name.
  - [ ] Staff can filter by membership status.
  - [ ] Results are paginated and tenant-scoped.

### alpha-exercise-library — Exercise library and program templates _(depends on: mvp-program)_

Let trainers reuse exercises from a per-gym library and save/apply program templates instead of authoring everything from scratch.

- **alpha-exercise-library-001** Per-gym exercise library
  - [ ] Trainers can add exercises to a gym library.
  - [ ] Library exercises can be inserted into a program.
  - [ ] Library is tenant-scoped.
- **alpha-exercise-library-002** Save and apply program templates
  - [ ] A program can be saved as a reusable template.
  - [ ] A new program can be created from a template.
  - [ ] Templates are tenant-scoped.

### alpha-program-lifecycle — Multi-program management, editing, and history _(depends on: mvp-program, mvp-member-portal)_

Support multiple programs per member over time, editing/re-assigning programs, and a member-visible history of past and current programs.

- **alpha-program-lifecycle-001** Multiple assignments with active/archived states
  - [ ] A member can have one active and several archived programs.
  - [ ] Re-assigning archives the prior active program.
  - [ ] States are enforced server-side.
- **alpha-program-lifecycle-002** Program history in the member portal
  - [ ] Members see their active program by default.
  - [ ] Members can browse archived programs read-only.
  - [ ] History remains member-scoped under RLS.

### alpha-invite-lifecycle — Invite lifecycle management _(depends on: mvp-member-management)_

Give staff control over invites: view status, resend, and revoke pending invites.

- **alpha-invite-lifecycle-001** Invite status tracking and dashboard view
  - [ ] Each invite shows an accurate status.
  - [ ] Staff can see pending vs accepted invites.
  - [ ] Status updates when an invite is accepted or expires.
- **alpha-invite-lifecycle-002** Resend and revoke invites
  - [ ] Resending issues a fresh email and valid token.
  - [ ] Revoking invalidates the token immediately.
  - [ ] Revoked/expired tokens are rejected at acceptance.

## Beta — Polished, production-ready, and compliant for an EU/Cyprus launch.

**Success criteria:**

- GDPR data export and erasure flows exist for members and staff.
- A comprehensive automated test suite proves cross-tenant and cross-member isolation cannot be bypassed across every table.
- Errors are handled gracefully with monitoring; invite emails reliably deliver and pass SPF/DKIM.
- The member portal and staff dashboard meet WCAG AA basics and perform well on mobile.

### beta-gdpr — GDPR data-subject rights _(depends on: alpha-member-records)_

Implement EU/GDPR compliance flows: data export and erasure for members and staff, plus consent/retention handling appropriate for the Cyprus launch.

- **beta-gdpr-001** Data export for members and staff
  - [ ] A member's data can be exported on request.
  - [ ] Export includes only that subject's data.
  - [ ] Export is logged for audit.
- **beta-gdpr-002** Erasure and retention handling
  - [ ] A data subject can be erased or anonymised.
  - [ ] Erasure respects referential integrity without leaking other tenants' data.
  - [ ] Retention behaviour is documented and configurable.

### beta-isolation-audit — Comprehensive security and RLS isolation audit _(depends on: mvp-platform-foundation)_

Extend the MVP smoke tests into a comprehensive automated suite plus a manual audit proving cross-tenant and cross-member access is impossible by construction at the DB layer across every table and code path.

- **beta-isolation-audit-001** Comprehensive cross-tenant/member isolation tests
  - [ ] Tests cover every tenanted table and write path.
  - [ ] All cross-tenant and cross-member access attempts fail.
  - [ ] Tests run in CI on each change and gate deploys.
- **beta-isolation-audit-002** Security review of auth and JWT handling
  - [ ] No code path trusts tenant_id/user from the client.
  - [ ] Tokens are verified, scoped, and expirable.
  - [ ] Findings are documented and remediated.

### beta-hardening — Error handling, observability, and email deliverability _(depends on: mvp-member-portal)_

Make the app production-grade: graceful error handling, logging/monitoring, and deliverability hardening for the transactional email provisioned in MVP (SPF/DKIM, bounce/failure handling).

- **beta-hardening-001** Global error handling and monitoring
  - [ ] Unexpected errors show friendly messages, not stack traces.
  - [ ] Errors are logged and monitored.
  - [ ] Critical failures raise alerts.
- **beta-hardening-002** Email deliverability hardening
  - [ ] Invite emails pass SPF and DKIM.
  - [ ] Send failures and bounces are handled and surfaced.
  - [ ] Deliverability verified against common inbox providers.

### beta-polish-a11y — Accessibility, performance, and UX polish _(depends on: mvp-member-portal)_

Final polish: WCAG AA basics, mobile performance for the member portal, and UX refinement across the staff dashboard.

- **beta-polish-a11y-001** Accessibility pass (WCAG AA basics)
  - [ ] Key flows are keyboard navigable.
  - [ ] Contrast and labels meet WCAG AA basics.
  - [ ] Automated a11y checks pass on core pages.
- **beta-polish-a11y-002** Mobile performance and UX refinement
  - [ ] Member portal meets a defined mobile performance budget.
  - [ ] Common staff workflows are streamlined.
  - [ ] No major layout shifts or jank on mobile.

## GA — Member engagement & the trainer feedback loop. Turn the read-only portal into a two-way training tool so trainers can see that programs are actually being followed.

MVP/Alpha/Beta delivered a complete, compliant, isolated CRM — but the member
portal is strictly **read-only**, so the differentiating wedge (member-facing
programs) is a one-way broadcast: a trainer cannot tell whether a member ever
opened, started, or completed the program they built. GA closes that loop. It
introduces the first **member-written** data (workout logging), surfaces it back
to trainers as adherence/engagement signal, and keeps the same hard guarantees —
every new entity is tenant- and member-isolated by RLS and covered by GDPR
export/erasure + retention from day one.

**Success criteria:**

- A member can log that they completed a workout against an assigned program,
  optionally with perceived effort and a note, from the mobile portal.
- A member can see a history of their recent logged sessions; the portal is no
  longer read-only but a member still cannot see or write anyone else's data.
- Trainers can see, per member, whether and how recently programs are being
  followed (engagement/adherence), turning the wedge into a feedback loop.
- All new member-written data is isolated by RLS across every table and path,
  and is covered by GDPR export, erasure/anonymisation, and retention.

### ga-engagement — Member workout logging _(depends on: mvp-member-portal)_

The foundational, member-written entity: a member viewing their assigned program
can log a completed workout session. This is the first WRITE path on the portal.

- **ga-engagement-001** Workout-session logging (data layer, RLS, portal UI)
  - [x] A member can log a completed session against an assigned program, with optional effort (RPE 1–10) and note.
  - [x] A member can only log for themselves and only against a program assigned to them (enforced by RLS `with check`, not app code).
  - [x] A member sees their own recent sessions and cannot read or write another member's or gym's logs (RLS + isolation tests).
  - [x] Workout logs are included in GDPR export and scrubbed on member erasure; retention is documented.
- **ga-engagement-002** Per-exercise set logging (actual weights/reps/RPE per set)
  - [ ] A member can record actual sets/reps/weight against each exercise in a session.
  - [ ] Per-set entries roll up into the session log and the member's history.
  - [ ] All entries remain member-scoped under RLS and covered by GDPR/retention.

### ga-trainer-insights — Trainer adherence & engagement view _(depends on: ga-engagement)_

Surface the new member-written signal back to staff so the loop is visible.

- **ga-trainer-insights-001** Member adherence on the dashboard
  - [x] Staff can see, per member, last-logged date and recent session count.
  - [x] The member detail page lists the member's logged sessions (read-only for staff).
  - [x] All reads are tenant-scoped by RLS; staff never write a member's log.
- **ga-trainer-insights-002** Roster engagement indicators
  - [ ] The roster flags members with no recent activity (configurable window).
  - [ ] Indicators are tenant-scoped and performant on the existing roster query.

## v1-hardening — Review-driven improvements _(review: docs/REVIEW.md)_

A whole-app review (`docs/REVIEW.md`, 2026-06-24) confirmed the security model
(RLS-first isolation, server-derived identity, pure+shared validation) is sound
and that GA's first member-written path is correctly minimal. It also surfaced
concrete gaps: the two open GA tasks were never built, the staff dashboard
overview is a non-functional stub, and three migration files collide on the
`0003` prefix. This phase reconciles the open GA work and schedules the review
findings as numbered tasks. One small, obviously-correct UI fix (navigable
overview cards, raw tenant-UUID removed from `app/dashboard/page.tsx`) was
applied directly during the review; the rest is deferred here.

**Reconciliation of open GA items:** `ga-engagement-002` (per-exercise set
logging) and `ga-trainer-insights-002` (roster engagement indicators) remain
genuinely unimplemented — they are NOT closed. They are carried forward here at
higher priority as `review-hardening-set-logging-001` and
`review-hardening-roster-engagement-001` respectively, with their original
acceptance criteria preserved and tightened. Treat the GA entries as superseded
by these.

**Success criteria:**

- A trainer can spot disengaged members directly from the roster, without
  opening each profile, and the indicator is tenant-scoped and adds no N+1 cost
  to the roster query.
- A member can record actual per-set work (reps/weight/RPE) against each
  exercise in a session, rolled up into their history, still RLS-isolated and
  GDPR-covered.
- The staff dashboard overview shows live, tenant-scoped counts on navigable
  cards rather than a static stub.
- Migration filenames have unambiguous, intent-ordered numbering with a
  documented ordering guarantee.

### review-hardening-roster-engagement — Roster engagement indicators _(carries forward ga-trainer-insights-002; depends on: ga-trainer-insights)_

Surface the workout signal at the roster level so disengaged members are visible
at a glance, without regressing the existing search/filter/pagination query.

- **review-hardening-roster-engagement-001** Flag inactive members on the roster
  - [ ] The roster (`app/dashboard/members/page.tsx`) flags members with no logged session inside a configurable window (default `ADHERENCE_WINDOW_DAYS`).
  - [ ] The flag is computed with a single aggregate join against `workout_log`, not a per-row query (no N+1; verified by inspecting the issued SQL).
  - [ ] Indicators are tenant-scoped by RLS (`workout_log_staff_select`); a cross-tenant member id contributes nothing.
  - [ ] The existing name search, status filter, and pagination continue to work unchanged.

### review-hardening-set-logging — Per-exercise set logging _(carries forward ga-engagement-002; depends on: ga-engagement)_

Extend session logging from session-level (program + effort + note) to actual
per-set work, the natural next step for the feedback loop.

- **review-hardening-set-logging-001** Record actual sets/reps/weight per exercise
  - [ ] A member can record actual sets/reps/weight (and optional per-set RPE) against each exercise in a logged session.
  - [ ] Per-set entries roll up into the session log and the member's history view.
  - [ ] A pure `validate*Input` function guards per-set values before any DB round-trip, mirroring `validateWorkoutLogInput`.
  - [ ] All per-set entries remain member-scoped under RLS (new `with check` policies on the new table) and are covered by GDPR export, erasure/anonymisation, and retention.

### review-hardening-dashboard — Live staff dashboard overview _(depends on: alpha-member-records)_

Replace the static overview stub with live, tenant-scoped figures so the landing
page is useful rather than decorative.

- **review-hardening-dashboard-001** Live, navigable overview cards
  - [ ] The overview cards show live tenant-scoped counts (members, programs, recent assignments) read under `withTenantContext`.
  - [ ] Each card links to its section; no raw tenant UUID or other internal identifier is rendered to the user.
  - [ ] Counts are RLS-scoped to the staff member's gym and verified by a view/data test.

### review-hardening-migrations — Deterministic migration ordering _(depends on: mvp-platform-foundation)_

Remove the `0003` filename collision so applied order reflects intent and cannot
silently reorder as new migrations land.

- **review-hardening-migrations-001** Resolve duplicate 0003 migration numbers
  - [ ] No two migration files share a numeric prefix (renumber the three `0003_*.sql` files, preserving their current applied order).
  - [ ] `scripts/migrate.mjs` applies cleanly against both a fresh database and one where the original `0003_*` files are already recorded in `schema_migrations` (no double-apply, no gap failure).
  - [ ] The intended ordering guarantee is documented alongside the runner.
