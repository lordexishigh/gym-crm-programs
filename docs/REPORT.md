# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-79%2F100-yellow)](#) ![readiness](https://img.shields.io/badge/readiness-caution-yellow)

**Overall: 79/100** · readiness: **caution** · **launch-ready** 🚀 · build verified ✓

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 73 | `███████████████░░░░░` |
| Code quality | 86 | `█████████████████░░░` |
| Robustness & error handling | 79 | `████████████████░░░░` |
| Builds & tests | 84 | `█████████████████░░░` |
| UX & design | 77 | `███████████████░░░░░` |

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

- Security and isolation architecture is production-grade: RLS policies in migrations/0002_rls_policies.sql, withTenantContext wrapping every query, JWT verified server-side in lib/identity.ts with no trust placed on browser-supplied identity, and login throttling in lib/auth/login-throttle.ts.
- Test suite is substantive and explains its invariants: 239 tests covering health-probe timeout contracts, deploy-gate policy, dev-server readiness races, and start-wrapper fallback — each test file documents the specific production defect it prevents.
- Implementation is complete and unstubbed across all 8 spec features, with real domain logic in lib/programs.ts, lib/assignments.ts, lib/invites.ts, lib/members.ts, and full UI in app/dashboard/programs/ and app/portal/.
- Codebase has well-separated module boundaries with clear responsibilities: lib/ owns domain logic and DB access, app/dashboard/ owns staff UI, app/portal/ owns member UI, and lib/auth/ owns all identity concerns — no cross-cutting leakage visible in the sample.

## To improve

- The E2E suite (e2e/staff-journey.spec.ts and e2e/invite-flow.spec.ts) is not wired into the CI gate that produces the green result — add a ci.yml step that runs `npx playwright test` against a seeded database so authenticated flows (dashboard load, program creation, member portal render) are machine-verified on every push rather than left to manual crawl.
- The automated check warns 'no error tracking or global error handler' despite app/global-error.tsx existing — wire a real error-reporting sink (e.g. Sentry DSN) into instrumentation.ts so production runtime exceptions are visible; the current observability stack in lib/observability/monitoring.ts captures metrics but not unhandled exceptions.
- Two img elements lack alt text (automated WARN) — audit app/page.tsx and app/dashboard/ for bare <img> tags and add descriptive alt attributes, which is also a WCAG 2.1 AA failure blocking accessibility compliance.
- The server readiness race has caused /portal/login and /login to time out in every evaluation round since Round 3 — scripts/dev.mjs should poll /api/health until it returns HTTP 200 before yielding to the caller, mirroring the contract already tested in test/dev-server.test.ts but not enforced in the dev entry point.

## Summary

All 8 spec features are genuinely implemented with production-quality code, strong RLS isolation, and a substantive 239-test suite — but the running app has failed to serve any authenticated page across 8 consecutive evaluation rounds, leaving the product's core wedge (program authoring, assignment, and the member portal) completely unverifiable at runtime; resolving the server readiness race and wiring E2E tests into CI are the two changes that would most close this gap.

---
_Scored 2026-07-31 20:02 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
