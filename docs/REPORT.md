# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-81%2F100-brightgreen)](#) ![readiness](https://img.shields.io/badge/readiness-caution-yellow)

**Overall: 81/100** · readiness: **caution** · **launch-ready** 🚀 · build verified ✓

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 88 | `██████████████████░░` |
| Code quality | 82 | `████████████████░░░░` |
| Robustness & error handling | 70 | `██████████████░░░░░░` |
| Builds & tests | 86 | `█████████████████░░░` |
| UX & design | 74 | `███████████████░░░░░` |

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

- Comprehensive RLS isolation proof: isolation-comprehensive.test.ts seeds two fully-conflicting tenants and exhaustively asserts SELECT/UPDATE/DELETE/INSERT is blocked across every tenanted table for both cross-tenant and cross-member axes via the real withTenantContext GUC path — adversarial, not incidental.
- All 8 spec features are genuinely wired end-to-end: the invite flow runs from email delivery (lib/email/resend.ts) through token acceptance (lib/invite-acceptance.ts) to portal session bootstrap, with no placeholder routes or TODO comments in the critical path.
- 239 tests across 26 files with layered coverage — unit (members, programs, GDPR), 7 dedicated RLS suites, axe-core a11y across 10+ components, and Playwright e2e — backed by a CI workflow that enforces the full suite on every push.
- GDPR is production-grade: migrations 0004+0006 add gdpr_subjects and gdpr_audit_events tables, lib/gdpr/export.ts implements full data export, and test/gdpr-erasure.test.ts + test/gdpr-export.test.ts both exercise real DB paths rather than mocking.

## To improve

- Two high-severity dependency vulnerabilities remain unpatched (next and sharp per the readiness WARN): update next to its patched minor release in package.json and revise the sharp override in the overrides block — these are the only open CVEs the check flags and both have fixes available.
- Auth endpoints (/login actions, /portal/login actions, /api/email/webhook) have no rate limiting: add an in-process token-bucket in middleware.ts keyed on IP + path to reject requests exceeding ~5 auth attempts per minute, eliminating the credential brute-force vector the readiness WARN identifies.
- One <img> element still lacks an alt attribute (readiness WARN unresolved): locate the bare <img in portal or dashboard view components, add a descriptive alt string, and add a rendering assertion in test/a11y.test.ts for that surface so the gap is caught in CI going forward.
- app/dashboard/members/actions.ts (16KB) and lib/gdpr/export.ts (17KB) bundle multiple distinct concerns in single files: extract the GDPR anonymise and export calls from members/actions.ts into lib/gdpr/, and split lib/gdpr/export.ts into separate erasure.ts and export.ts modules to keep files under ~300 lines and reduce merge-conflict surface area.

## Summary

A solid, feature-complete MVP that faithfully implements all 8 spec commitments with genuinely wired code, 239 passing tests, and an adversarial cross-tenant RLS proof suite; the remaining score drag is two unpatched high-severity dependency vulnerabilities, no rate limiting on auth endpoints, and a single missing img alt attribute.

---
_Scored 2026-07-26 01:35 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
