# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-75%2F100-yellow)](#) ![readiness](https://img.shields.io/badge/readiness-caution-yellow)

**Overall: 75/100** · readiness: **caution** · **launch-ready** 🚀 · build verified ✓

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 70 | `██████████████░░░░░░` |
| Code quality | 80 | `████████████████░░░░` |
| Robustness & error handling | 78 | `████████████████░░░░` |
| Builds & tests | 82 | `████████████████░░░░` |
| UX & design | 65 | `█████████████░░░░░░░` |

## Readiness checks

**Security**
- ✅ No hardcoded secrets — no secret-shaped literals found
- ✅ Secrets file ignored — .env present but gitignored
- ✅ Row-Level Security — RLS enabled on the schema
- ⚠️ Dependency vulnerabilities — 2 high-severity vulnerability(ies) in dependencies
- ✅ Rate limiting — rate limiting present on the API

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

- Adversarial cross-tenant isolation test in test/isolation-comprehensive.test.ts seeds two fully-populated conflicting tenants and probes every tenanted table for SELECT/UPDATE/DELETE/forged-INSERT leakage — this is a genuinely thorough security backstop, not a spot-check.
- Production-grade observability stack: health probe returns 503 with per-dependency breakdown, instrumentation.ts wires onRequestError globally so uncaught server errors are captured without per-call instrumentation, and auth calls have bounded timeouts with regression tests.
- Feature surface substantially exceeds the spec: Stripe billing, class scheduling with waitlist auto-promotion, QR/PIN check-in, GDPR export/erasure, workout logs, and membership plan tiers are all wired up with migrations, lib modules, and UI — the product is closer to a full gym CRM than a bare MVP.
- 18 sequential, idempotent migrations with a schema_migrations guard give the schema a clear, auditable evolution history from blank to full feature set.

## To improve

- The product walkthrough shows /login and /portal/login timing out even though test/start-wrapper.test.ts passes — add a /api/health readiness poll inside scripts/start.mjs so the process does not signal readiness until the Next.js HTTP server is actually accepting connections on the port, preventing the QA crawler from racing against boot.
- 2 high-severity vulnerabilities in next and sharp are still open per the automated readiness check — run npm audit fix (or pin next to the patched version listed in its advisory) and update sharp in the overrides block in package.json.
- app/dashboard/members/actions.ts at 18,522 bytes combines invite dispatch, GDPR anonymisation/export, status-history writes, and check-in PIN generation in one file — split the GDPR actions into app/dashboard/members/gdpr-actions.ts and the invite actions into invite-actions.ts to restore single-responsibility and keep individual files reviewable.
- The a11y readiness check still flags 1 img without alt text — locate the element (likely in app/portal/ProgramView.tsx or app/dashboard/exercises/ExerciseLibraryGrid.tsx where exercise images are rendered) and add a descriptive alt attribute, then add that component to the rendering surface covered by test/a11y.test.ts.
- Bulk member CSV import is absent and flagged as a hard adoption blocker in the market-fit check — add a dashboard route app/dashboard/members/import/page.tsx with a server action that parses a uploaded CSV, previews the parsed rows, and bulk-inserts via withTenantContext so gyms migrating from incumbents do not have to hand-enter every record.

## Summary

The codebase is impressively complete — all 8 spec features are implemented with real code, RLS is enforced and adversarially tested, and the feature surface exceeds the spec significantly — but the product walkthrough could not confirm any authenticated flow because both auth entry points timed out at runtime, leaving the assembled product's usability unverified and dragging the overall score; fixing the startup-readiness race and the two open dependency vulnerabilities are the highest-leverage next steps.

---
_Scored 2026-07-27 17:08 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
