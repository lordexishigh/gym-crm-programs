# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-83%2F100-brightgreen)](#) ![readiness](https://img.shields.io/badge/readiness-caution-yellow)

**Overall: 83/100** · readiness: **caution** · **launch-ready** 🚀 · build verified ✓

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 90 | `██████████████████░░` |
| Code quality | 85 | `█████████████████░░░` |
| Robustness & error handling | 72 | `██████████████░░░░░░` |
| Builds & tests | 86 | `█████████████████░░░` |
| UX & design | 76 | `███████████████░░░░░` |

## Readiness checks

**Security**
- ✅ No hardcoded secrets — no secret-shaped literals found
- ✅ Secrets file ignored — .env present but gitignored
- ✅ Row-Level Security — RLS enabled on the schema
- ⚠️ Dependency vulnerabilities — 2 high-severity vulnerability(ies) in dependencies
- ⚠️ Rate limiting — auth endpoints have no rate limiting — credential brute-force and abuse are unprotected

**Quality**
- ✅ Automated tests — test files present
- ✅ Dependencies pinned — lockfile/requirements present
- ✅ License declared — license present
- ✅ Builds & tests pass — final smoke test passed
- ⚠️ Accessibility basics — 1 <img> without alt text

**Compliance**
- ✅ Dependency licenses — no copyleft conflicts found
- ✅ Privacy policy & terms — legal page present
- ✅ Cookie consent — no analytics/trackers detected

**Growth**
- ✅ SEO & discoverability — meta tags, robots.txt and sitemap present

## Strengths

- All eight spec features are genuinely implemented and wired to real Postgres RLS — no stubs or TODO placeholders found across the sampled server actions, lib modules, or components.
- Adversarial isolation test suite (test/isolation-comprehensive.test.ts, 25KB) seeds two fully-populated conflicting tenants and proves cross-tenant SELECT/UPDATE/DELETE/INSERT blocking through the real withTenantContext/app_user role path.
- Complete invite-to-portal onboarding is end-to-end — token generation, email delivery tracking (migrations/0007), invite acceptance, member linking, auto-signin, and portal redirect are all wired with a Playwright journey spec (e2e/invite-flow.spec.ts) that exercises the real built app against a local Postgres.
- 239 passing tests across 26 files covering unit, RLS, GDPR, a11y (axe-core), e2e Playwright, and visual-capture paths, with a CI workflow and a db-safety guard that refuses to run destructive tests against a non-local database URL.

## To improve

- Auth endpoints in app/login/actions.ts and app/portal/login/actions.ts have no rate limiting — add a sliding-window IP check at the middleware layer (middleware.ts already runs on every request) so repeated failed logins are rejected before they reach the Server Action.
- Two high-severity dependency vulnerabilities (next, sharp) remain in package.json despite the dependency-update task — run npm audit fix, pin the patched versions, and add an npm audit --audit-level=high step to .github/workflows/ci.yml so regressions are caught in CI.
- One <img> element is missing an alt attribute (readiness WARN still present) — locate the image in the portal or dashboard components (likely app/portal/ProgramView.tsx or app/dashboard/page.tsx), add a descriptive alt, and extend test/a11y.test.ts to render that surface so the rule is enforced going forward.
- Staff role separation between owner and trainer is absent — every authenticated staff session has identical access including any future billing/revenue surfaces; add a role enum column to the users table and a requireRole('owner') guard (mirroring requireStaff in lib/auth/session.ts) so trainers cannot reach owner-only routes.

## Summary

A genuinely complete and well-tested CRM build — all eight spec features are wired to real Postgres RLS, 239 tests pass, and the assembled product boots and passes the final smoke test. The remaining gaps are operational rather than structural: no rate limiting on auth endpoints, two high-severity dependency vulnerabilities unpatched, and a single missing alt attribute — all fixable without architectural change.

---
_Scored 2026-07-25 17:06 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
