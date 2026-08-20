# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-25%2F100-red)](#) ![readiness](https://img.shields.io/badge/readiness-blocked-red)

**Overall: 25/100** · readiness: **blocked**

**Live:** https://r2-a6h4ci2g0-lordexishighs-projects.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 48 | `██████████░░░░░░░░░░` |
| Code quality | 77 | `███████████████░░░░░` |
| Robustness & error handling | 62 | `████████████░░░░░░░░` |
| Builds & tests | 22 | `████░░░░░░░░░░░░░░░░` |
| UX & design | 44 | `█████████░░░░░░░░░░░` |

## Readiness checks

**Security**
- ⚠️ No hardcoded secrets — 1 in test fixtures only (not shipped code): hardcoded secret in test/task-dispatch.test.ts
- ✅ Secrets file ignored — no .env present
- ✅ Row-Level Security — RLS enabled on the schema
- ✅ Dependency vulnerabilities — no critical/high vulnerabilities in the last audit
- ✅ Rate limiting — rate limiting present on the API

**Quality**
- ✅ Automated tests — test files present
- ✅ No stub/placeholder code — no stub markers found
- ✅ Dependencies pinned — lockfile/requirements present
- ✅ License declared — license present
- ❌ Builds & tests pass — final product smoke test did not pass
- ❌ App works at runtime — the product walkthrough could not be repeated (No page could be loaded.), so nothing about this app's behaviour has been verified — an unproven app is not a working one
- ⚠️ Accessibility basics — 2 <img> without alt text

**Compliance**
- ✅ Dependency licenses — no copyleft conflicts found
- ✅ Privacy policy & terms — legal page present
- ⚠️ Cookie consent — analytics/trackers present but no cookie-consent mechanism found

**Growth**
- ✅ SEO & discoverability — meta tags, robots.txt and sitemap present

## Strengths

- Tenant isolation is enforced where it counts and proven, not asserted: RLS is enabled and FORCED, and test/isolation-coverage.test.ts discovers every table carrying tenant_id from the live pg catalog so a future tenanted table without a policy fails CI by construction.
- The GDPR path is a complete workflow rather than a schema: lib/gdpr/deletion-requests.ts plus migration 0026, the portal-side DataPrivacy.tsx, and the staff-side deletion-requests/ route, with test/gdpr-deletion-requests.test.ts asserting the full submit → pending → tombstone → roster-disappears loop including cross-tenant negatives.
- Tests carry their own reasoning: test/dev-server.test.ts pins a measured readiness defect (port open at 3.3s, GET / at 19.3s) with numbers, and test/members.test.ts asserts exact normalised shapes rather than truthiness.

## To improve

- App works at runtime: the product walkthrough could not be repeated (No page could be loaded.), so nothing about this app's behaviour has been verified — an unproven app is not a working one
- Builds & tests pass: final product smoke test did not pass
- /login and /portal/login still time out (90s in the current walkthrough), and the cause is in the render path, not deployment: make both pages render with zero I/O — move the `lib/auth/supabase.ts` and `lib/db.ts` imports out of app/login/page.tsx and app/portal/login/page.tsx (import them only inside the Server Actions in the sibling actions.ts) and add an explicit `connectionTimeoutMillis` plus `statement_timeout` to the Pool in lib/db.ts so any auth-backend stall returns a rendered form with an error instead of hanging.
- The landing page's three entry points in app/page.tsx ('Staff sign in', 'Member portal', and the DemoSignInHint demo link) all dead-end with no fallback; give app/page.tsx a server-side reachability check against /api/health and render an explicit 'service unavailable' state with the demo credentials inline, so a first-time user gets a message rather than a 90-second hang.
- Fix the two accessibility failures the deterministic check flags: replace the bare `<img>` elements in the member-photo surfaces (app/components/Avatar.tsx and app/dashboard/members/MemberPhotoPanel.tsx) with `next/image` carrying a real `alt` derived from the member's full name, and empty `alt=""` where the image is decorative.
- Analytics ship without consent: app/WebVitals.tsx and lib/observability/report-client.ts post to /api/observability/report on every page load with no consent gate — add a consent cookie check that suppresses the beacon until accepted, and a dismissible banner in app/layout.tsx, matching what docs/legal/COOKIES.md already promises.
- Split app/dashboard/members/actions.ts (29KB): the GDPR export/anonymise actions, the photo-upload actions, and the member-task actions each belong in their own colocated actions file (e.g. app/dashboard/members/[id]/gdpr-actions.ts), so a single member-form submission no longer drags the Supabase admin client and image sniffer into its module graph.

## Summary

A genuinely substantial and well-tested codebase — forced RLS with a self-extending coverage test, a complete GDPR erasure workflow, real program authoring and portal views — sitting behind a product that a user cannot enter at all: the smoke test fails, the runtime walkthrough loaded only the landing page, and both login routes hang. Until /login and /portal/login render without blocking I/O, none of the implemented spec is deliverable.

---
_Scored 2026-08-20 18:45 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
