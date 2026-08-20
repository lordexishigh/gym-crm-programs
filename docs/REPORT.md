# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-25%2F100-red)](#) ![readiness](https://img.shields.io/badge/readiness-blocked-red)

**Overall: 25/100** · readiness: **blocked** · build verified ✓

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 58 | `████████████░░░░░░░░` |
| Code quality | 82 | `████████████████░░░░` |
| Robustness & error handling | 68 | `██████████████░░░░░░` |
| Builds & tests | 72 | `██████████████░░░░░░` |
| UX & design | 45 | `█████████░░░░░░░░░░░` |

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
- ✅ Builds & tests pass — final smoke test passed
- ❌ App works at runtime — the product walkthrough could not be repeated (No page could be loaded.), so nothing about this app's behaviour has been verified — an unproven app is not a working one
- ⚠️ Accessibility basics — 2 <img> without alt text

**Compliance**
- ✅ Dependency licenses — no copyleft conflicts found
- ✅ Privacy policy & terms — legal page present
- ⚠️ Cookie consent — analytics/trackers present but no cookie-consent mechanism found

**Growth**
- ✅ SEO & discoverability — meta tags, robots.txt and sitemap present

## Strengths

- Security is enforced where it actually holds: `withTenantContext` runs every query as the unprivileged `app_user`, and test/workout-logs-rls.test.ts and test/task-queue-rls.test.ts prove isolation by driving the real read/write path under member, staff, and cross-tenant identities rather than asserting on application-level WHERE clauses.
- GDPR is implemented rather than documented — lib/gdpr/export.ts builds a role-scoped subject export and logs it in the same tenant-scoped transaction, with exported tombstone constants (ERASED_MEMBER_NAME et al.) so post-erasure shape is asserted by tests and cannot drift silently.
- The test suite carries genuine engineering knowledge, not coverage theatre: test/dev-server.test.ts pins the measured `next dev` readiness race (port at 3.3s, 'Ready' at 5.1s, first 200 at 19.3s) with the numbers that make the defect legible.
- Feature depth well beyond the spec is genuinely wired up — CSV member import (ImportWizard.tsx + lib/member-import.ts), check-in PINs, class scheduling with waitlists, Stripe webhooks, and an exercise library all have route, action, lib, and migration layers.

## To improve

- App works at runtime: the product walkthrough could not be repeated (No page could be loaded.), so nothing about this app's behaviour has been verified — an unproven app is not a working one
- The deployed start path has no readiness gate: scripts/lib/dev-server.mjs already exports `openGate`/`warmUp`/`missingRenderDeps` and test/dev-server.test.ts proves the race, but the production start used by the walkthrough does not go through it — wire `warmUp` (pre-request `/login`, `/portal/login`, and `/api/health` before reporting ready) into the `start` script in package.json and the deploy step in .github/workflows/deploy.yml so the process never announces readiness while routes are still compiling.
- Add a Playwright smoke spec under e2e/ that asserts `GET /login` and `GET /portal/login` each return 200 with their form rendered, and run it in .github/workflows/ci.yml against a built server — the existing e2e specs (staff-journey, invite-flow) all presuppose an app that already loads, so the single defect that has blocked every round is the one thing CI never checks.
- Split app/dashboard/members/actions.ts (26.5 KB): it currently imports and orchestrates member CRUD, invite token generation/email, GDPR export/anonymise, check-in PIN generation, photo sniffing, and member tasks in one 'use server' module — move invites into app/dashboard/invites/actions.ts, GDPR into app/dashboard/members/gdpr-actions.ts, and photo handling alongside app/api/members/[id]/photo/route.ts.
- Add the missing `alt` attributes on the 2 flagged `<img>` elements (most likely in app/components/Avatar.tsx and app/dashboard/members/MemberPhotoPanel.tsx) — use the member's name, or `alt=""` where the image is decorative next to a visible name label.
- Add a cookie-consent gate for the analytics path: app/WebVitals.tsx and lib/observability/report-client.ts post to /api/observability/report unconditionally, so add a consent banner component and have WebVitals no-op until consent is stored — required under GDPR for a Cyprus-market product that already ships docs/legal/PRIVACY.md and COOKIES.md.
- Implement staff role separation in lib/auth/session.ts and lib/staff.ts: there is a single staff session with no owner/trainer distinction, so every logged-in staff member sees all members, all classes, and BillingPanel.tsx — add a `role` column and scope the members/classes queries (and ideally an RLS policy) so a trainer sees only their assigned members.

## Summary

A deep, security-serious codebase — real RLS-enforced multi-tenancy proven by database-level tests, GDPR export/erasure, and feature coverage well past the spec — sitting behind a startup defect that makes the entire product unreachable: /login and /portal/login have timed out in the walkthrough for eight consecutive rounds, so nothing beyond the landing page can be used or verified. The build passes its own tests while failing the only check that matters to a user, and the fix is a readiness gate plus a CI smoke test that actually requests those two routes.

---
_Scored 2026-08-20 16:51 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
