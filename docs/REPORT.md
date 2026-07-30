# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-78%2F100-yellow)](#) ![readiness](https://img.shields.io/badge/readiness-caution-yellow)

**Overall: 78/100** · readiness: **caution** · **launch-ready** 🚀 · build verified ✓

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 73 | `███████████████░░░░░` |
| Code quality | 83 | `█████████████████░░░` |
| Robustness & error handling | 77 | `███████████████░░░░░` |
| Builds & tests | 87 | `█████████████████░░░` |
| UX & design | 74 | `███████████████░░░░░` |

## Readiness checks

**Security**
- ✅ No hardcoded secrets — no secret-shaped literals found
- ✅ Secrets file ignored — .env present but gitignored
- ✅ Row-Level Security — RLS enabled on the schema
- ⚠️ Dependency vulnerabilities — 2 high-severity vulnerability(ies) in dependencies
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

- RLS isolation is enforced at the database layer and guarded by a CI test (test/isolation-coverage.test.ts) that auto-discovers every tenant-carrying table from the live pg_class catalog, making it structurally impossible for a new table to ship without RLS without breaking CI.
- Pure/impure module discipline is consistent: lib/member-photo.ts and lib/members.ts carry no database or environment imports and are fully unit-testable in isolation, while DB queries are confined to actions.ts and lib/db.ts withTenantContext calls.
- The test suite is substantively non-trivial — 239 tests including infrastructure regression guards (dev server startup race, missing-build fallback, RLS auto-discovery) that pin real, previously-observed failure modes with measured evidence.
- Feature scope significantly exceeds the spec: exercise library per tenant, class scheduling with waitlist, billing/membership plans, GDPR export and erasure, member photo upload with magic-byte sniffing, bulk CSV import, and workout logging are all wired up beyond what was promised.

## To improve

- Two high-severity dependency vulnerabilities are unaddressed (automated WARN) — run `npm audit` to identify the affected packages and pin safe versions or apply `npm audit fix` so the dependency risk does not reach production.
- The crawl has failed to authenticate past /login or /portal/login across every evaluation round — verify the demo credential flow (trainer@demo.local / DemoTrainer!2026 and member@demo.local / DemoMember!2026) works end-to-end in the deployed environment by running a headed Playwright script against the live URL and confirming the staff dashboard, member list, program builder, and member portal each render with seeded data.
- Error tracking has no external sink (automated WARN) — wire lib/observability/monitoring.ts captureException to a real DSN (Sentry, BetterStack, or equivalent) so production exceptions are visible; currently the global-error.tsx boundary catches errors but nothing surfaces them outside the process.
- Two `<img>` elements are missing alt attributes (automated WARN) — locate them (likely in app/components/Avatar.tsx or member photo surfaces) and add descriptive alt text or alt="" for decorative images to clear the accessibility warning.
- No reporting dashboard exists (/dashboard/reports is absent from the file tree and market fit check flags it as missing) — add a reports page backed by aggregation queries over payment_events (MRR), members (active count), and class_bookings (attendance per class) so gym owners have a baseline business view.

## Summary

The codebase is genuinely complete against the spec — all eight promised features are implemented without stubs, the test suite is sophisticated and passes at 239 tests, and the scope far exceeds the pitch. The dominant risk remains that the crawl cannot authenticate in the running app across multiple evaluation rounds, leaving every post-login feature runtime-unverified; resolving the deployed demo credential flow is the single highest-leverage action before this build can be called production-ready.

---
_Scored 2026-07-30 21:39 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
