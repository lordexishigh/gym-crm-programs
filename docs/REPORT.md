# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-40%2F100-red)](#) ![readiness](https://img.shields.io/badge/readiness-blocked-red)

**Overall: 40/100** · readiness: **blocked**

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 68 | `██████████████░░░░░░` |
| Code quality | 81 | `████████████████░░░░` |
| Robustness & error handling | 74 | `███████████████░░░░░` |
| Builds & tests | 45 | `█████████░░░░░░░░░░░` |
| UX & design | 67 | `█████████████░░░░░░░` |
| Works at runtime | 40 | `████████░░░░░░░░░░░░` |

## Readiness checks

**Security**
- ⚠️ No hardcoded secrets — 1 in test fixtures only (not shipped code): hardcoded secret in test/task-dispatch.test.ts
- ✅ Secrets file ignored — .env present but gitignored
- ✅ Row-Level Security — RLS enabled on the schema
- ✅ Dependency vulnerabilities — no critical/high vulnerabilities in the last audit
- ✅ Rate limiting — rate limiting present on the API

**Quality**
- ✅ Automated tests — test files present
- ✅ No stub/placeholder code — no stub markers found
- ✅ Dependencies pinned — lockfile/requirements present
- ✅ License declared — license present
- ⚠️ Builds & tests pass — the project's own tests and type-checks pass; the build is marked unverified for the reason under 'App works at runtime'
- ❌ App works at runtime — 5 product gap(s) found by the walkthrough; first: The crawl reached only 3 pre-authentication pages despite being described as authenticated — the entire post-login product is unverified; confirm demo credentia
- ⚠️ Accessibility basics — 2 <img> without alt text

**Compliance**
- ✅ Dependency licenses — no copyleft conflicts found
- ✅ Privacy policy & terms — legal page present
- ⚠️ Cookie consent — analytics/trackers present but no cookie-consent mechanism found

**Growth**
- ✅ SEO & discoverability — meta tags, robots.txt and sitemap present

## Strengths

- Comprehensive RLS + identity enforcement: withTenantContext wraps every mutation server-side, requireStaff() guards every staff action, and identity is derived from the signed JWT — the security model is correctly layered and the automated RLS check passes.
- 239 passing tests across 80+ files covering RLS isolation, payment validation, GDPR export/erasure, rate limiting, accessibility, and schema correctness — the unit and integration test suite is one of the build's clearest assets.
- GDPR implementation is thorough and thoughtful: immutable payment ledger with a void trail, tombstone constants exported for test assertion, export and erasure in a single tenant-scoped transaction, and audit logging tied to every sensitive operation.
- Program authoring, exercise library, member management, and invite flow all have substantial implementations (ProgramBuilder.tsx 7 kB, members/actions.ts 27 kB, 26 migrations) with no stub markers — the surface area of the product is genuinely built, not scaffolded.

## To improve

- App works at runtime: 5 product gap(s) found by the walkthrough; first: The crawl reached only 3 pre-authentication pages despite being described as authenticated — the entire post-login product is unverified; confirm demo credentia
- The runtime smoke test has failed in every evaluation round — investigate scripts/smoke-portal.mjs and the deploy workflow to confirm the seed step (scripts/seed.mjs) runs post-deploy so demo credentials exist, and add a /api/health poll in the CI deploy job before marking the app ready for QA.
- Cookie consent is absent despite analytics trackers being present (WARN flagged by automated check) — add a consent banner in app/layout.tsx that gates analytics script injection until the user accepts, as this is a compliance gap for GDPR-regulated markets.
- Two img elements are missing alt attributes (automated accessibility WARN) — audit app/components/Avatar.tsx and any img tags in dashboard and portal pages and add descriptive alt strings.
- The hardcoded secret in test/task-dispatch.test.ts should be replaced with a clearly fake constant (e.g. 'test-secret-fixture') so the secrets scanner produces no warnings even in test fixtures.

## Summary

The build has genuine, non-stub implementations of all eight spec features backed by a strong 239-test suite and solid RLS/GDPR foundations, but the product smoke test has failed in every round without exception — the crawler cannot authenticate past /login in any run, leaving the entire post-login product unverifiable at runtime and the build's most important promise unproven.

---
_Scored 2026-08-21 11:11 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
