# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-40%2F100-red)](#) ![readiness](https://img.shields.io/badge/readiness-blocked-red)

**Overall: 40/100** · readiness: **blocked** · build verified ✓

**Live:** https://wt-gym.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 50 | `██████████░░░░░░░░░░` |
| Code quality | 81 | `████████████████░░░░` |
| Robustness & error handling | 72 | `██████████████░░░░░░` |
| Builds & tests | 68 | `██████████████░░░░░░` |
| UX & design | 63 | `█████████████░░░░░░░` |
| Works at runtime | 32 | `██████░░░░░░░░░░░░░░` |

## Readiness checks

**Security**
- ⚠️ No hardcoded secrets — 2 in test fixtures only (not shipped code): hardcoded secret in test/demo-sign-in.test.ts; hardcoded secret in test/task-dispatch.test.ts
- ✅ Secrets file ignored — no .env present
- ✅ Row-Level Security — RLS enabled on the schema
- ⚠️ Dependency vulnerabilities — 1 high-severity vulnerability(ies) in dependencies
- ✅ Rate limiting — rate limiting present on the API

**Quality**
- ✅ Automated tests — test files present
- ✅ No stub/placeholder code — no stub markers found
- ✅ Dependencies pinned — lockfile/requirements present
- ✅ License declared — license present
- ✅ Builds & tests pass — final smoke test passed
- ❌ App works at runtime — 5 product gap(s) found by the walkthrough; first: Both /login and /portal/login time out (90s) and never load — fix the server routes or startup so both entry points respond before the app can be used at all.
- ⚠️ Accessibility basics — 2 <img> without alt text

**Compliance**
- ✅ Dependency licenses — no copyleft conflicts found
- ✅ Privacy policy & terms — legal page present
- ⚠️ Cookie consent — analytics/trackers present but no cookie-consent mechanism found

**Growth**
- ✅ SEO & discoverability — meta tags, robots.txt and sitemap present

## Strengths

- All eight spec features have real, substantive implementations with no stub markers — app/dashboard/members/actions.ts alone is 26k chars of production-grade Server Actions backed by real DB queries inside withTenantContext.
- E2E journey tests are genuinely thorough: e2e/staff-journey.spec.ts (17k chars) drives the full staff flow (sign-in → member creation → program authoring → assignment) against a real Postgres, and e2e/invite-flow.spec.ts covers the complete member onboarding path with documented rationale for why each prior check was insufficient.
- Security fundamentals are solid end-to-end: RLS enforced at the DB layer, withTenantContext wrapping every tenant-scoped query, requireStaff/requireMember guards on all Server Actions, a dedicated login throttle, and a rate limiter — all passing their automated checks.

## To improve

- App works at runtime: 5 product gap(s) found by the walkthrough; first: Both /login and /portal/login time out (90s) and never load — fix the server routes or startup so both entry points respond before the app can be used at all.
- /login and /portal/login have timed out in every runtime evaluation across all eight rounds — add an explicit ready-gate in scripts/start.mjs that polls /api/health until it returns 200 before the process reports ready, matching the startup probe already implemented and tested in scripts/lib/dev-server.mjs and test/dev-server.test.ts; without this fix no rubric dimension can improve because the product is unreachable.
- Cookie consent is absent despite the automated WARN flagging analytics trackers present — add a consent banner in app/layout.tsx that gates analytics script loading behind user acceptance, consistent with the GDPR obligations already documented in docs/legal/COMPLIANCE.md.
- Two <img> elements are missing alt text (automated WARN) — audit app/components/Avatar.tsx and app/dashboard/members/MemberPhotoPanel.tsx, which are the most likely sources given their image-rendering role, and add descriptive alt strings or aria-label attributes to clear the accessibility failure.

## Summary

The codebase is feature-complete and well-engineered — all eight spec features are implemented without stubs, 239 tests pass, and security fundamentals are solid — but the running application has failed the same runtime check in every round since the start, with both login routes timing out and the entire product surface unreachable; fixing the server startup race in scripts/start.mjs is the single change that unlocks every other dimension.

---
_Scored 2026-08-20 04:13 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
