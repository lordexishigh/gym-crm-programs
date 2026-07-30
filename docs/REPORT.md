# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-76%2F100-yellow)](#) ![readiness](https://img.shields.io/badge/readiness-caution-yellow)

**Overall: 76/100** · readiness: **caution** · **launch-ready** 🚀 · build verified ✓

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 72 | `██████████████░░░░░░` |
| Code quality | 83 | `█████████████████░░░` |
| Robustness & error handling | 65 | `█████████████░░░░░░░` |
| Builds & tests | 88 | `██████████████████░░` |
| UX & design | 76 | `███████████████░░░░░` |

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

- RLS enforcement is real and deep: withTenantContext wraps every DB call in app/dashboard/members/actions.ts, lib/gdpr/export.ts, and lib/programs.ts, and the automated RLS check passes — tenant isolation is not a claim, it is wired into every write path.
- The test suite is high-signal: dev-server.test.ts and start-wrapper.test.ts are 20-24 KB regression guards that pin specific measured failure modes (port-binds-before-ready race, missing build black-hole), not assertion-free smoke tests.
- GDPR compliance is fully implemented: lib/gdpr/export.ts and lib/gdpr/audit.ts deliver portable JSON export, tombstone anonymisation with named constants, and a per-tenant audit trail — all in one transaction so an export is recorded iff it succeeds.
- Demo credentials are now visible on the login forms without requiring authentication, resolving the long-standing first-time-user blocker that appeared in every prior round.

## To improve

- Add rate limiting to app/login/actions.ts and app/portal/login/actions.ts (or in middleware.ts on the /login and /portal/login routes) — the automated check explicitly flags these as brute-force-unprotected, and no per-IP throttle exists anywhere in the current source.
- Run 'npm audit fix' and update the 2 high-severity vulnerable packages — their names are available from 'npm audit'; leaving known high-severity CVEs in place is a concrete risk, not a theoretical one.
- The product walkthrough has failed to reach any authenticated page for 8+ consecutive rounds — the Supabase credentials in the deployment environment must be valid and the demo seed must run against the connected DB; add a smoke step in .github/workflows/ci.yml that authenticates as trainer@demo.local via the API and asserts a 200 from /dashboard, so this regression is caught in CI rather than discovered by the walkthrough.
- Fix the one img missing an alt attribute flagged by the accessibility WARN — grep app/ for '<img' without an alt prop and add descriptive alt text; this is a single targeted change that clears the WARN and prevents screen-reader failures.

## Summary

The build is architecturally complete — all 8 spec features are implemented without stubs, the test suite is substantial and passes, and code quality is genuinely high — but authenticated runtime verification has failed in every evaluation round and three security WARNs (no auth rate limiting, high-severity dependency CVEs, invisible production errors) hold the overall score back from the high-80s it could otherwise reach.

---
_Scored 2026-07-30 19:24 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
