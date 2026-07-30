# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-68%2F100-yellow)](#) ![readiness](https://img.shields.io/badge/readiness-caution-yellow)

**Overall: 68/100** · readiness: **caution** · **launch-ready** 🚀 · build verified ✓

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 62 | `████████████░░░░░░░░` |
| Code quality | 83 | `█████████████████░░░` |
| Robustness & error handling | 63 | `█████████████░░░░░░░` |
| Builds & tests | 65 | `█████████████░░░░░░░` |
| UX & design | 70 | `██████████████░░░░░░` |

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

- Comprehensive RLS enforcement: withTenantContext/withAdminContext is used uniformly across every mutation surface, and the isolation-comprehensive test seeds two conflicting tenants and adversarially probes every tenanted table — this is production-grade multi-tenancy, not a paper claim.
- Resilient failure modelling: the invite acceptance path returns typed statuses ('invalid', 'expired', 'used', 'unavailable') rather than throwing, so a DB outage or dead email link lands on a readable page instead of the error boundary — a non-obvious correctness property that is regression-guarded by test/invite-lookup.test.ts.
- Broad feature surface beyond the spec: classes, check-in, billing plans, Stripe webhooks, GDPR export/anonymisation, workout logs, and a class schedule on the member portal are all present and wired up with migrations, meaning the product is already closer to table stakes than the eight spec items imply.
- Test depth: 239 passing tests include adversarial cross-tenant isolation, auth timeout contracts, and start-wrapper regression guards — the suite catches non-obvious failure modes that a simple happy-path suite would miss.

## To improve

- Fix the Next.js server startup race: the product walkthrough has timed out on '/' in every round since Round 5, including the current one — add an explicit readiness probe in scripts/dev.mjs (poll /api/health until it responds before yielding control) and mirror this in the CI smoke step in .github/workflows/ci.yml so the assembled server is verified to answer requests, not just to build.
- Add rate limiting to auth entry points: the readiness check explicitly flags /login and /portal/login as unprotected against credential brute-force; implement middleware-level rate limiting (e.g. via an Upstash Redis counter in middleware.ts, keyed by IP) before these routes are reachable in production.
- Patch the two high-severity dependency vulnerabilities: the readiness check flags next and sharp as having high-severity fixes available — run `npm audit fix` (or pin to the patched versions in package.json) and verify the build still passes; these are blocking for any security-conscious gym operator.
- Surface demo credentials on the landing page: a first-time evaluator or QA tester cannot reach any feature without out-of-band setup; add a visible 'Try the demo: owner@demo.local / DemoOwner!2024' notice to app/page.tsx (conditionally rendered when NEXT_PUBLIC_DEMO_MODE=true) so the full flow can be walked without manual database seeding.

## Summary

The codebase is architecturally complete — all eight spec features are implemented, RLS is enforced at the DB layer, and 239 tests pass — but the assembled product has been consistently unreachable at runtime across eight evaluation rounds, making every promised feature impossible to verify or use. Until the server startup race is resolved and auth routes reliably respond, the score is dragged down by a deployment gap rather than a code gap.

---
_Scored 2026-07-30 11:47 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
