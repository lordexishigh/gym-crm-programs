# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-80%2F100-brightgreen)](#) ![readiness](https://img.shields.io/badge/readiness-caution-yellow)

**Overall: 80/100** · readiness: **caution** · **launch-ready** 🚀 · build verified ✓

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 78 | `████████████████░░░░` |
| Code quality | 83 | `█████████████████░░░` |
| Robustness & error handling | 80 | `████████████████░░░░` |
| Builds & tests | 87 | `█████████████████░░░` |
| UX & design | 74 | `███████████████░░░░░` |

## Readiness checks

**Security**
- ✅ No hardcoded secrets — no secret-shaped literals found
- ✅ Secrets file ignored — .env present but gitignored
- ✅ Row-Level Security — RLS enabled on the schema
- ✅ Dependency vulnerabilities — no critical/high vulnerabilities in the last audit
- ✅ Rate limiting — rate limiting present on the API

**Quality**
- ✅ Automated tests — test files present
- ✅ No stub/placeholder code — no stub markers found
- ✅ Dependencies pinned — lockfile/requirements present
- ✅ License declared — license present
- ✅ Builds & tests pass — final smoke test passed
- ⚠️ Accessibility basics — 2 <img> without alt text

**Compliance**
- ✅ Dependency licenses — no copyleft conflicts found
- ✅ Privacy policy & terms — legal page present
- ✅ Cookie consent — no analytics/trackers detected

**Growth**
- ✅ SEO & discoverability — meta tags, robots.txt and sitemap present

## Strengths

- Security architecture is genuinely defence-in-depth: JWT identity is derived server-side via jose (lib/identity.ts), never trusted from the browser, and all DB queries run under withTenantContext as the RLS-bound app_user — a tenant isolation model that is correct by construction rather than by convention.
- The test suite is substantive and behaviorally meaningful: 239 passing tests include timing-contract assertions for the health probe, policy-decision unit tests for the deploy script, a dev-server readiness gate regression guard, and a demo-credential drift detector — none of these are trivial happy-path stubs.
- Operational readiness is well above baseline: bounded health probes, structured observability (lib/observability/), GDPR export/anonymisation pipeline (lib/gdpr/export.ts at 18 KB), Stripe webhook handling, rate limiting (lib/rate-limit.ts), and full CI/CD in .github/workflows/ with a dedicated membership-expiry workflow.
- All 8 spec features are implemented in real, wired-up code with no stub markers — program authoring (ProgramBuilder.tsx, ExerciseDraftList.tsx), assignment (AssignPanel.tsx, lib/assignments.ts), member portal (app/portal/ProgramView.tsx, portal/programs/[id]/page.tsx), and invite flow (app/invite/accept/, lib/invites.ts) are all present and connected.

## To improve

- e2e/staff-journey.spec.ts must actually submit the trainer@demo.local credentials, assert the dashboard loads with seeded member data, navigate to /dashboard/programs, create a program with at least one exercise (sets/reps/rest/notes), assign it to the seeded member, then log in as member@demo.local on /portal/login and confirm the program renders — without this chain, the product's entire wedge remains unverified at the running-app layer across every evaluation round.
- The automated check 'Error visibility: no error tracking or global error handler' is still flagging WARN despite lib/observability/monitoring.ts existing — wire captureException into app/global-error.tsx (which is already present but apparently not calling it) so unhandled server errors are surfaced to the monitoring sink rather than silently swallowed in production.
- Two img elements lack alt text (automated WARN) — locate the offending renders (likely in app/components/Avatar.tsx or the member photo panel) and add descriptive alt attributes to clear the accessibility check.
- scripts/smoke-portal.mjs was added in the latest file-change round but it is unclear whether it is wired into .github/workflows/ci.yml as a required step — if the portal smoke runs only locally and not in CI, a broken /portal/login will not block a merge; add it as a required job in the CI workflow.

## Summary

A mature, fully-implemented codebase — all 8 spec features are genuinely wired up, security is defence-in-depth, and 239 behaviorally substantive tests pass — but the product has failed to execute a single post-authentication user journey in any evaluation round, leaving program authoring, assignment, and the member portal entirely unverified at runtime; closing that gap with a real end-to-end login-through-portal test chain is the single highest-leverage improvement.

---
_Scored 2026-07-31 20:00 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
