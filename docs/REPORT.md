# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-79%2F100-yellow)](#) ![readiness](https://img.shields.io/badge/readiness-caution-yellow)

**Overall: 79/100** · readiness: **caution** · **launch-ready** 🚀 · build verified ✓

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 88 | `██████████████████░░` |
| Code quality | 81 | `████████████████░░░░` |
| Robustness & error handling | 67 | `█████████████░░░░░░░` |
| Builds & tests | 79 | `████████████████░░░░` |
| UX & design | 72 | `██████████████░░░░░░` |

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

- Every one of the eight spec features is fully wired end-to-end — no stubs or TODOs; the program authoring flow (ProgramBuilder → ExerciseDraftList → LibraryPicker → AssignPanel) is the most complete expression of the product's wedge.
- The adversarial cross-tenant isolation suite (test/isolation-comprehensive.test.ts, 25KB) seeds two fully-populated conflicting tenants and probes every tenanted table for SELECT/UPDATE/DELETE/INSERT leakage — this is meaningfully better than per-feature RLS spot checks.
- GDPR compliance is a first-class citizen: lib/gdpr/export.ts + erasure, migration 0004_gdpr_rights.sql, audit trails, data-retention policy, and dedicated test suites — rare at this stage of a product.
- E2E Playwright coverage includes the complete invite-accept-portal journey against a real Postgres, with visual captures at mobile and desktop viewports committed as build artifacts.

## To improve

- Add rate limiting to app/login/actions.ts and app/portal/login/actions.ts — both are unprotected credential endpoints; a simple in-memory token-bucket (or Vercel's edge rate-limit middleware) would close the brute-force vector flagged by the automated readiness check.
- Upgrade next and sharp to their patched versions — both have high-severity CVEs that were flagged in round 3 and remain; update the lockfile and re-run the readiness check to clear the WARN.
- Locate and fix the single <img> without alt text that the readiness check still WARNs on — search app/portal/ and app/dashboard/ for bare <img> tags or next/image usages without an alt prop, add a descriptive alt string, and extend test/a11y.test.ts to render that surface so the regression is guarded.
- Wire an error-tracking sink into lib/observability/monitoring.ts and the global-error.tsx handler — the readiness check flags that production failures are invisible; even a simple POST to an ops webhook on captureException would satisfy the operational gap without adding a paid dependency.
- Introduce a trainer vs. owner role distinction in lib/auth/session.ts and the dashboard layout — currently a single staff role means owners cannot gate billing or revenue data away from trainers; add a role column to the users table and a requireOwner() guard for any future billing routes to unblock the staff role separation market-fit gap.

## Summary

A complete, well-architected multi-tenant CRM that genuinely delivers all eight promised spec features with strong database-layer security and an unusually rigorous adversarial isolation test suite; the main score drag is operational readiness — unpatched high-severity dependencies, no auth rate limiting, and no error-tracking sink — rather than missing product features.

---
_Scored 2026-07-25 17:18 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
