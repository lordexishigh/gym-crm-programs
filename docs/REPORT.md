# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-72%2F100-yellow)](#) ![readiness](https://img.shields.io/badge/readiness-caution-yellow)

**Overall: 72/100** · readiness: **caution** · **launch-ready** 🚀 · build verified ✓

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 70 | `██████████████░░░░░░` |
| Code quality | 80 | `████████████████░░░░` |
| Robustness & error handling | 63 | `█████████████░░░░░░░` |
| Builds & tests | 82 | `████████████████░░░░` |
| UX & design | 62 | `████████████░░░░░░░░` |

## Readiness checks

**Security**
- ✅ No hardcoded secrets — no secret-shaped literals found
- ✅ Secrets file ignored — .env present but gitignored
- ✅ Row-Level Security — RLS enabled on the schema
- ⚠️ Dependency vulnerabilities — 2 high-severity vulnerability(ies) in dependencies
- ⚠️ Rate limiting — auth endpoints have no rate limiting — credential brute-force and abuse are unprotected

**Quality**
- ✅ Automated tests — test files present
- ✅ No stub/placeholder code — no stub markers found
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

- Comprehensive RLS enforcement: withTenantContext wraps every DB query in lib/ and all Server Actions call requireStaff() before touching data, so no query path can bypass tenant isolation at the application layer.
- Disciplined schema evolution: 18 sequential migrations cover every feature area (RLS policies, exercise library, GDPR rights, assignment lifecycle, class scheduling, check-in, payment events) with no schema drift or missing coverage for implemented features.
- Substantive operational test suite: 239 tests include regression guards for infrastructure failure modes — postinstall build policy, TCP readiness gate timing, and PIN collision avoidance — that directly address real incidents documented in the test file headers.
- GDPR implementation is genuinely complete: lib/gdpr/export.ts implements both staff DSAR fulfilment and member self-service export in one tenant-scoped transaction, with tombstone anonymisation, audit logging, and role-scoped query access — not a stub.

## To improve

- Surface demo credentials inline on the landing page (app/page.tsx): the DEMO section already exists but shows no email/password and no one-click login button; add the seed account's email and password as visible text or a 'Sign in as demo trainer' button so any evaluator can reach the dashboard without out-of-band setup — this single change would unblock runtime verification of all eight spec features.
- Add rate limiting to the staff and portal login Server Actions (app/login/actions.ts and app/portal/login/actions.ts): the automated readiness check flags these endpoints as unprotected against credential brute-force; implement a simple in-process sliding-window counter keyed on IP or email, or add an upstash/redis-backed limiter, since these are the only unauthenticated write paths in the product.
- Patch the two high-severity dependency vulnerabilities in next and sharp (package.json): the readiness check flags these as unresolved; run npm audit fix --force for these two packages and verify the build still passes, as shipping known high-severity CVEs in a multi-tenant SaaS is a direct tenant-data risk.
- Add a waitlist_entries table and auto-promotion handler to lib/classes.ts: migrations/0015 and lib/classes.ts already implement class scheduling with capacity limits, but the market fit analysis confirms no waitlist table, migration, or named promotion handler exists; when a capped class receives a cancellation the slot stays empty — this is the highest-impact missing table-stakes feature given the scheduling infrastructure is already in place.
- Fix the missing alt text on the img flagged by the accessibility readiness check (WARN): locate the unattributed <img> element (likely in app/page.tsx or a portal component given the screenshot evidence) and add a descriptive alt attribute; this is a one-line fix that closes the only open accessibility warning.

## Summary

The codebase is a genuine, well-structured implementation of all eight spec features with no stubs, strong RLS enforcement, and a substantive 239-test suite — but the product has failed runtime verification through authentication across eight consecutive evaluation rounds because demo credentials are never surfaced to the evaluator, making every core feature unverifiable in the running app and suppressing confidence in spec coverage and UX scores alike.

---
_Scored 2026-07-30 17:58 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
