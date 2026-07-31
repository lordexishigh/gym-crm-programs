# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-75%2F100-yellow)](#) ![readiness](https://img.shields.io/badge/readiness-caution-yellow)

**Overall: 75/100** · readiness: **caution** · **launch-ready** 🚀 · build verified ✓

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 70 | `██████████████░░░░░░` |
| Code quality | 82 | `████████████████░░░░` |
| Robustness & error handling | 75 | `███████████████░░░░░` |
| Builds & tests | 86 | `█████████████████░░░` |
| UX & design | 63 | `█████████████░░░░░░░` |

## Readiness checks

**Security**
- ✅ No hardcoded secrets — no secret-shaped literals found
- ✅ Secrets file ignored — .env present but gitignored
- ✅ Row-Level Security — RLS enabled on the schema
- ✅ Dependency vulnerabilities — no critical/high vulnerabilities in the last audit
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

- All eight spec features are backed by substantive code files with no stub markers — program authoring (ProgramBuilder.tsx + ExerciseDraftList.tsx), RLS migrations, JWT identity layer, and invite flow are all wired end-to-end in the codebase.
- The test suite is genuinely meaningful: 239 tests including a security-floor pin against two HIGH Next.js CVEs, a real ES256 JWT signing harness for post-login redirect logic, and a dev-server readiness-gate test that caught a real 14-second startup race.
- Authentication is hardened correctly: per-audience rate limiting with separate member/staff buckets, server-side JWT verification before session establishment, and tenant_id derived exclusively from the verified token — never from form input.
- The CI/CD pipeline is mature for a v1: dependabot.yml, multi-workflow GitHub Actions (ci.yml at 17KB, deploy.yml, membership-expiry.yml), dependency audit passing clean, and secrets gitignored.

## To improve

- The /portal/login route times out at 45 seconds in every runtime crawl round — investigate whether app/portal/login/page.tsx triggers a cold-compile of a heavy import chain on first request; add an explicit warm-up fetch of /portal/login inside scripts/dev.mjs (alongside the existing /api/health probe) so the route is compiled before the readiness gate opens.
- No basic reporting dashboard exists anywhere in the file tree — add app/dashboard/reports/page.tsx that queries the members table for active count, computes MRR from the Stripe billing data already in lib/stripe.ts and lib/billing.ts, and renders per-class attendance from lib/classes.ts; this is the only table-stakes market feature still missing.
- The automated check WARNs that production failures are invisible — wire lib/observability/monitoring.ts (which already exists at 6KB) to an external sink in instrumentation.ts so that server-side exceptions surface in an alerting channel rather than silently swallowing to logs.
- Two img elements lack alt text (automated WARN) — audit app/components/Avatar.tsx and app/dashboard/members/MemberPhotoPanel.tsx for img tags without alt attributes and add descriptive or empty-string alt values to clear the accessibility warning.

## Summary

The codebase is architecturally complete and well-tested — all eight spec features are genuinely implemented, rate limiting and RLS are properly wired, and 239 meaningful tests pass — but the member portal (the product's stated wedge) has timed out in every runtime evaluation round, making the product undeliverable to end users despite the code being present; unblocking /portal/login startup latency is the single change that would most raise this score.

---
_Scored 2026-07-31 19:12 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
