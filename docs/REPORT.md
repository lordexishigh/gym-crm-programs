# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-70%2F100-yellow)](#) ![readiness](https://img.shields.io/badge/readiness-caution-yellow)

**Overall: 70/100** · readiness: **caution** · **launch-ready** 🚀 · build verified ✓

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 65 | `█████████████░░░░░░░` |
| Code quality | 82 | `████████████████░░░░` |
| Robustness & error handling | 68 | `██████████████░░░░░░` |
| Builds & tests | 76 | `███████████████░░░░░` |
| UX & design | 60 | `████████████░░░░░░░░` |

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

- Security architecture is genuinely defence-in-depth: JWT claims verified server-side via JWKS (lib/identity.ts), withTenantContext enforced in every server action, RLS on all 18 migrated tables, and a 25 000-line comprehensive isolation audit that adversarially probes cross-tenant and cross-member write paths.
- Test suite is meaningfully broad and well-motivated: 239 passing tests include regression guards that document the exact observed failure (quoted timing measurements, browser-tab symptoms) before pinning the fix—far above the stub-test level.
- Feature implementation is complete and non-stub: all 8 spec features have real UI components, server actions, lib modules, and migrations wired together with no TODO markers or placeholder branches, confirmed by the automated stub check.
- Dependency hygiene is solid: lockfile present, no copyleft conflicts, dependencies pinned, and the sharp/next vulnerabilities from round 3 were patched (package.json shows next ^15.5.21).

## To improve

- The auth route cold-start timeout has persisted through rounds 5, 6, and 7 despite the dev-server readiness gate rewrite: extend the readiness gate in scripts/lib/dev-server.mjs to pre-warm /login and /portal/login (not just '/') with an HTTP GET before signalling ready, so the Playwright crawl does not land during the per-route compilation window.
- Rate limiting is absent on app/login/actions.ts and app/portal/login/actions.ts (automated WARN): add an in-memory or Redis token-bucket guard (e.g. a middleware check keyed on IP with a 10-attempt/minute ceiling) before the GoTrue signIn call to block credential brute-force.
- Error tracking is not wired up despite instrumentation.ts existing (automated WARN): integrate an exception reporter (Sentry DSN or equivalent) in instrumentation.ts register() and verify app/global-error.tsx actually calls captureException so production failures surface rather than disappearing silently.
- The one remaining img without alt text (automated WARN) has not been fixed across multiple rounds: run 'grep -rn "<img" app/' to locate the offending element, add a descriptive alt attribute, and add a render assertion in test/a11y.test.ts covering that component so the gap cannot regress.

## Summary

The codebase is a complete, well-architected implementation of the spec with strong security depth and a meaningful test suite, but the product is non-functional in practice: auth entry points have timed out on every walkthrough for three consecutive evaluation rounds, making every spec feature unreachable to a real user, which caps spec_coverage and ux_design scores regardless of what the source shows.

---
_Scored 2026-07-30 02:54 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
