# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-40%2F100-red)](#) ![readiness](https://img.shields.io/badge/readiness-blocked-red)

**Overall: 40/100** · readiness: **blocked** · build verified ✓

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 58 | `████████████░░░░░░░░` |
| Code quality | 78 | `████████████████░░░░` |
| Robustness & error handling | 66 | `█████████████░░░░░░░` |
| Builds & tests | 70 | `██████████████░░░░░░` |
| UX & design | 60 | `████████████░░░░░░░░` |
| Works at runtime | 32 | `██████░░░░░░░░░░░░░░` |

## Readiness checks

**Security**
- ⚠️ No hardcoded secrets — 1 in test fixtures only (not shipped code): hardcoded secret in test/task-dispatch.test.ts
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

- All 8 spec features have concrete, non-stub implementations in the file tree — ProgramBuilder, AssignPanel, invite acceptance flow, RLS-enforced withTenantContext, and the full portal directory are all present and fully fleshed out.
- The test suite is genuinely substantive: 239 tests including real-Postgres RLS isolation suites, startup-race regression guards, and smoke-portal decision tests that pin the exact failure modes that previously slipped past CI.
- Security posture is strong in the code: RLS enforced at the DB layer, identity derived server-side from signed JWT (lib/identity.ts), per-IP rate limiting, login throttling, and GDPR anonymisation with an audit trail in a single transaction.
- Module boundaries are clean — lib/ owns data access, app/ owns UI/routing, Server Actions are the only mutation surface, and withTenantContext is the sole query entry point, making tenant isolation easy to audit.

## To improve

- App works at runtime: 5 product gap(s) found by the walkthrough; first: Both /login and /portal/login time out (90s) and never load — fix the server routes or startup so both entry points respond before the app can be used at all.
- The /login and /portal/login 90 s timeout has been reported in every round since Round 1 and is still present — add an explicit readiness gate in scripts/dev.mjs that polls /api/health (or app/api/health/route.ts) until HTTP 200 before yielding control, and add a CI smoke step in .github/workflows/ci.yml that waits on this gate before running the walkthrough; this one fix unblocks verification of every other feature.
- The undici high-severity CVE and the moderate next/postcss vulnerabilities are still unpatched after Round 8's report — run npm audit fix --force against the pinned lockfile and update package.json to the resolved safe versions.
- Cookie consent is absent (WARN) despite analytics and trackers being loaded — add a consent banner component mounted in app/layout.tsx that gates analytics scripts (app/WebVitals.tsx) on user acceptance, with preference persisted in a cookie.
- Two img elements lack alt attributes (accessibility WARN from readiness checks) — locate them (likely in app/portal/ or app/dashboard/members/MemberPhotoPanel.tsx) and add descriptive alt strings so screen readers and lighthouse audits pass.
- Staff role separation is missing from the running UI: lib/staff.ts exists but app/dashboard has no role-gated routes — add a requireRole('owner') guard (alongside the existing requireStaff) to the billing and reports routes, and hide trainer-irrelevant nav items in app/dashboard/layout.tsx based on the session role.

## Summary

The codebase is fully implemented — all 8 spec features are present in non-stub code, 239 tests pass, and security fundamentals are solid — but the product has been completely inaccessible at runtime for 8 consecutive evaluation rounds because /login and /portal/login time out, making every promised feature undemonstrable; fixing the server startup race is the single highest-leverage change.

---
_Scored 2026-08-20 01:59 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
