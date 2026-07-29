# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-72%2F100-yellow)](#) ![readiness](https://img.shields.io/badge/readiness-caution-yellow)

**Overall: 72/100** · readiness: **caution** · **launch-ready** 🚀 · build verified ✓

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 72 | `██████████████░░░░░░` |
| Code quality | 83 | `█████████████████░░░` |
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

- Multi-tenant isolation is adversarially verified: test/isolation-comprehensive.test.ts seeds two conflicting tenants, probes every tenanted table for cross-SELECT/UPDATE/DELETE/forged-INSERT, and drives the real withTenantContext + app_user RLS path — not a mock.
- Auth design is unusually careful: no @supabase/supabase-js dependency, GoTrue called over raw fetch with an explicit AbortSignal budget, JWT claims always re-verified server-side via lib/identity.ts, and test/auth-client.test.ts pins the bounded-wait contract against the pathological 'never-responds' case.
- The build substantially exceeds the spec scope with genuinely wired features: Stripe payment events, class scheduling with waitlist auto-promotion (lib/classes.ts), QR/PIN check-in, GDPR right-to-erasure (lib/gdpr/export.ts, 18 KB), and per-tenant exercise library — none of these are stubs.
- Test coverage is broad and purposeful: 239 tests including accessibility (axe-core via test/a11y.test.ts), a start-wrapper smoke test that builds and probes the assembled product, e2e invite-flow spec, and GDPR schema tests — all wired into CI.

## To improve

- The member portal (/portal/login and /portal/*) times out on every request in the running product despite passing unit tests — trace why app/portal/login/page.tsx or its underlying Server Action (app/portal/login/actions.ts) hangs in the assembled build; the start-wrapper test passes in isolation but the full walkthrough disagrees, suggesting a middleware or environment-variable resolution failure that only manifests under next start.
- Auth endpoints (/login and /portal/login) have no rate limiting — add a sliding-window counter in middleware.ts (keyed on IP + pathname) so credential brute-force is blocked before it reaches the GoTrue token endpoint; the readiness check flags this as an open attack surface.
- Two high-severity dependency vulnerabilities remain unpatched (next and sharp flagged in the readiness WARN) — run npm audit fix or pin to the patched versions in package.json now; both have available fixes per the audit output.
- One <img> element is missing an alt attribute (readiness WARN, carried across multiple rounds) — grep for <img without alt across app/portal/ and app/dashboard/ components, add a descriptive alt, and extend test/a11y.test.ts to render that surface so the regression is guarded.
- The staff login page has no forgot-password link and no visible error state for wrong credentials — add a /login/forgot-password route handler that calls GoTrue's password-reset endpoint and surface a link beneath the Sign in button in app/login/page.tsx so locked-out users have a recovery path.

## Summary

Technically a strong build: all spec features are genuinely implemented (not stubbed), multi-tenant RLS is adversarially tested, auth hardening is thoughtful, and the scope far exceeds the original brief — but the member portal, the product's stated differentiator, times out on every runtime request despite passing unit tests, auth endpoints are unprotected against brute-force, and two high-severity dependency vulnerabilities remain open, leaving the assembled product not ready for first use.

---
_Scored 2026-07-30 01:23 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
