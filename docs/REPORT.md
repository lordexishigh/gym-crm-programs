# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-40%2F100-red)](#) ![readiness](https://img.shields.io/badge/readiness-blocked-red)

**Overall: 40/100** · readiness: **blocked**

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 63 | `█████████████░░░░░░░` |
| Code quality | 83 | `█████████████████░░░` |
| Robustness & error handling | 74 | `███████████████░░░░░` |
| Builds & tests | 28 | `██████░░░░░░░░░░░░░░` |
| UX & design | 66 | `█████████████░░░░░░░` |
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
- ❌ Builds & tests pass — final product smoke test did not pass
- ❌ App works at runtime — 6 product gap(s) found by the walkthrough; first: The crawl was declared authenticated but reached only 3 public-facing pages (/, /login, /portal/login) — no staff dashboard, member list, program builder, or me
- ⚠️ Accessibility basics — 2 <img> without alt text

**Compliance**
- ✅ Dependency licenses — no copyleft conflicts found
- ✅ Privacy policy & terms — legal page present
- ⚠️ Cookie consent — analytics/trackers present but no cookie-consent mechanism found

**Growth**
- ✅ SEO & discoverability — meta tags, robots.txt and sitemap present

## Strengths

- Full 26-migration schema with per-table RLS policies and a withTenantContext abstraction that makes cross-tenant data access structurally impossible at the application layer — no ad-hoc WHERE tenant_id clauses needed.
- 239-test suite with named regression guards covering RLS isolation, GDPR export and erasure, login throttle, payment parsing, and readiness-gate timing — tests document invariants rather than just asserting outputs.
- Market-specific implementation depth: decimal comma parsing for Cyprus locale, SEPA as a first-class payment method with an immutable void-trail ledger, and per-tenant exercise libraries — these are not generic scaffold features.
- Readiness gate in scripts/lib/dev-server.mjs that polls /api/health until routes actually serve (not just when the port opens), directly addressing the 14-second Next.js compile window that caused repeated timeout failures.

## To improve

- App works at runtime: 6 product gap(s) found by the walkthrough; first: The crawl was declared authenticated but reached only 3 public-facing pages (/, /login, /portal/login) — no staff dashboard, member list, program builder, or me
- Builds & tests pass: final product smoke test did not pass
- The smoke test has failed in every round: investigate app/login/actions.ts to confirm the Supabase session cookie is set and redirect() targets /dashboard (not an empty or broken destination) — use the live staff-login.spec.ts in e2e/live/ to get a real post-auth page assertion before any other work.
- The landing page (app/page.tsx) has zero button or form elements — the DemoSignInHint component should render a form that POSTs demo credentials directly to the login action so a first-time user or QA reviewer can reach the dashboard with one click rather than copying credentials manually.
- Cookie consent is absent despite analytics and Web Vitals trackers being initialised in app/WebVitals.tsx and instrumentation.ts — add a consent banner component that gates the analytics initialization calls until the user accepts, satisfying the WARN from the readiness checker.
- Two images are missing alt text (accessibility WARN) — audit app/components/Avatar.tsx and any other img-rendering components to add descriptive alt attributes; Avatar in particular is rendered on member records and the portal and carries meaningful identity content.

## Summary

The codebase is genuinely well-built — no stubs, solid RLS enforcement, a large typed test suite, and real market-specific implementation depth — but the smoke test has failed in every evaluation round and the running app has never served an authenticated page, leaving all eight spec features unverifiable at runtime; the code earns its score, the product does not yet exist for a user.

---
_Scored 2026-08-20 22:03 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
