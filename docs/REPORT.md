# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-40%2F100-red)](#) ![readiness](https://img.shields.io/badge/readiness-blocked-red)

**Overall: 40/100** · readiness: **blocked**

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 55 | `███████████░░░░░░░░░` |
| Code quality | 82 | `████████████████░░░░` |
| Robustness & error handling | 68 | `██████████████░░░░░░` |
| Builds & tests | 35 | `███████░░░░░░░░░░░░░` |
| UX & design | 62 | `████████████░░░░░░░░` |
| Works at runtime | 32 | `██████░░░░░░░░░░░░░░` |

## Readiness checks

**Security**
- ⚠️ No hardcoded secrets — 1 in test fixtures only (not shipped code): hardcoded secret in test/task-dispatch.test.ts
- ✅ Secrets file ignored — .env present but gitignored
- ✅ Row-Level Security — RLS enabled on the schema
- ⚠️ Dependency vulnerabilities — 1 high-severity vulnerability(ies) in dependencies
- ✅ Rate limiting — rate limiting present on the API

**Quality**
- ✅ Automated tests — test files present
- ✅ No stub/placeholder code — no stub markers found
- ✅ Dependencies pinned — lockfile/requirements present
- ✅ License declared — license present
- ❌ Builds & tests pass — final product smoke test did not pass
- ❌ App works at runtime — 5 product gap(s) found by the walkthrough; first: Both /login and /portal/login time out (90s) and never load — fix the server routes or startup so both entry points respond before the app can be used at all.
- ⚠️ Accessibility basics — 2 <img> without alt text

**Compliance**
- ✅ Dependency licenses — no copyleft conflicts found
- ✅ Privacy policy & terms — legal page present
- ⚠️ Cookie consent — analytics/trackers present but no cookie-consent mechanism found

**Growth**
- ✅ SEO & discoverability — meta tags, robots.txt and sitemap present

## Strengths

- The RLS architecture is genuinely complete: withTenantContext is the exclusive DB access path, the isolation-coverage test dynamically discovers every tenanted table from the live catalog and fails CI on any future table that ships without RLS, and the manual-payments-rls test covers cross-tenant read isolation, GDPR export, and erasure in one suite.
- Financial arithmetic is handled correctly throughout: parseAmountToCents rejects sub-cent precision rather than rounding, stores everything as integer cents to match the existing payment_events schema, and accepts comma decimals for the Cyprus locale — all enforced by unit tests with domain-specific justification in comments.
- The test infrastructure is substantive: 239 tests across 26 files, DB-dependent suites gracefully skip without DATABASE_URL, and the dev-server readiness gate (test/dev-server.test.ts) specifically addresses the 14-second gap between port-open and first-request-served that has repeatedly caused flaky CI.

## To improve

- App works at runtime: 5 product gap(s) found by the walkthrough; first: Both /login and /portal/login time out (90s) and never load — fix the server routes or startup so both entry points respond before the app can be used at all.
- Builds & tests pass: final product smoke test did not pass
- The /login and /portal/login routes time out in every evaluation round: diagnose whether a missing or malformed environment variable (SUPABASE_URL, SUPABASE_ANON_KEY, or DATABASE_URL) is causing the route module to throw at import time before any request is handled — add a startup-time env validation in instrumentation.ts that logs and exits cleanly rather than silently hanging.
- Cookie consent is absent despite analytics trackers being present and GDPR compliance being a core feature (beta-gdpr tasks completed): add a cookie-banner component in app/layout.tsx that gates analytics script loading behind explicit consent, matching the standard the GDPR export/erasure machinery already sets.
- The undici high-severity CVE is unpatched: run `npm audit fix` targeting undici specifically (it is a transitive Next.js dependency) and pin the resolved version in package.json so the lock file reflects the patched version.
- Two img elements are missing alt text (automated accessibility check WARN): locate the undecorated img renders — likely in app/components/Avatar.tsx given its 2,394-byte size and purpose — and add descriptive alt attributes or aria-hidden='true' for purely decorative images.

## Summary

The codebase is genuinely well-built — no stubs, correct RLS layering, solid financial arithmetic, and real test infrastructure — but the application has failed the runtime smoke test in every evaluation round: both auth entry points time out, leaving the entire product surface inaccessible and all spec features unverifiable to a first-time user. Fixing the server startup failure is the single change that would unlock verification of everything else.

---
_Scored 2026-08-19 22:15 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
