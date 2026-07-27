# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-77%2F100-yellow)](#) ![readiness](https://img.shields.io/badge/readiness-caution-yellow)

**Overall: 77/100** · readiness: **caution** · **launch-ready** 🚀 · build verified ✓

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 84 | `█████████████████░░░` |
| Code quality | 81 | `████████████████░░░░` |
| Robustness & error handling | 72 | `██████████████░░░░░░` |
| Builds & tests | 69 | `██████████████░░░░░░` |
| UX & design | 71 | `██████████████░░░░░░` |

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

- Adversarial cross-tenant isolation is genuinely tested: test/isolation-comprehensive.test.ts seeds two fully-populated conflicting tenants and asserts SELECT, UPDATE, DELETE, and forged-INSERT are all blocked for a gym-B session reading gym-A rows through the real withTenantContext/app_user role path — not mocked.
- The feature surface substantially exceeds the spec: Stripe billing with webhook handling (lib/stripe.ts, lib/stripe-events.ts, migrations/0014–0017), class scheduling with waitlist auto-promotion (lib/classes.ts, migration 0015), QR/PIN check-in (lib/checkin.ts, migration 0016), GDPR export and erasure (lib/gdpr/export.ts, migrations/0004/0006/0018), and automated email notifications are all present with proper schema backing.
- Privilege minimisation is precise: migration 0018 grants UPDATE on only the note column of workout_log (not the whole row) and adds a staff-scoped UPDATE RLS policy, so GDPR erasure works without breaking the immutability invariant that every other column remains non-updatable at the privilege level.
- 239 unit and integration tests across 26 files with DB-dependent suites cleanly skipping when DATABASE_URL is absent, plus E2E Playwright invite-flow and visual-capture specs and a dedicated a11y test suite — all green.

## To improve

- Auth routes (/login, /portal/login) hang indefinitely rather than failing fast when the database is unreachable — in lib/auth/session.ts add a pool.connect() timeout (e.g. connectionTimeoutMillis on the Pool constructor in lib/db.ts) and have requireStaff/requireMember return a redirect to an error page or throw a Next.js notFound() within 2–3 seconds so the browser never hangs on a blank tab.
- Auth Server Actions (app/login/actions.ts, app/portal/login/actions.ts) have no rate limiting — add an upstash/ratelimit sliding-window check keyed on IP before the credential query so brute-force and credential-stuffing are blocked at the application layer, closing the automated readiness WARN.
- Two high-severity dependency vulnerabilities (next, sharp) remain unresolved from Round 3 — run npm audit fix targeting those two packages, update the pinned versions in package.json, and regenerate package-lock.json so the CI vulnerability scan goes green.
- One img element is missing an alt attribute (automated readiness WARN) — locate it (likely in a portal or dashboard page component) and add a descriptive alt string, then add rendering coverage for that component in test/a11y.test.ts to prevent recurrence.

## Summary

A well-engineered, feature-rich codebase that goes substantially beyond the spec — RLS isolation with adversarial tests, Stripe billing, class scheduling, check-in, and GDPR are all genuinely implemented — but a critical runtime defect causes auth routes to hang in the deployed app, making the product unreachable to real users despite static tests passing, which is the single most important fix before any further evaluation.

---
_Scored 2026-07-27 13:25 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
