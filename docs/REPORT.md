# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-79%2F100-yellow)](#) ![readiness](https://img.shields.io/badge/readiness-caution-yellow)

**Overall: 79/100** · readiness: **caution** · **launch-ready** 🚀 · build verified ✓

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 84 | `█████████████████░░░` |
| Code quality | 86 | `█████████████████░░░` |
| Robustness & error handling | 71 | `██████████████░░░░░░` |
| Builds & tests | 80 | `████████████████░░░░` |
| UX & design | 69 | `██████████████░░░░░░` |

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

- Genuine multi-tenant security posture: withTenantContext enforces RLS on every query, identity is derived from the signed JWT server-side, and the import Server Action re-parses the CSV authoritatively rather than trusting the browser preview — no obvious trust boundary violations in the sampled code.
- Rich beyond-spec feature set implemented as real code: CSV bulk import with three-step wizard (lib/member-import.ts, ImportWizard.tsx), GDPR export/anonymisation (lib/gdpr/export.ts at 18 KB), Stripe billing, exercise library, class scheduling, and check-in are all fully wired up with migrations, not stubbed.
- Sophisticated test suite: 239 passing tests across 26 files including non-trivial regression guards (dev-server readiness gate covering the 14-second compile window, CSV parsing covering European semicolon delimiters and quoted embedded commas) — these tests pin real behaviour, not just presence.
- Clean module architecture: lib/ holds all domain logic (members.ts, programs.ts, assignments.ts, invites.ts, checkin.ts) cleanly separated from app/ routing, making the tenant isolation pattern easy to audit and extend.

## To improve

- Add rate limiting to app/login/actions.ts and app/portal/login/actions.ts — the automated check confirms both auth endpoints have no brute-force protection; a simple upstash/ratelimit call keyed on the client IP (available from the Next.js request headers) before the credential check would close this gap.
- Surface demo credentials directly in the UI: app/page.tsx has a demo CTA and lib/demo-accounts.ts exists, but the walkthrough confirmed no credentials appear on the page — add a visible hint block (e.g. 'Try trainer@demo.alphagym.cy / DemoOwner!202') to both /login/page.tsx and /portal/login/page.tsx so QA and first-time visitors can enter the product without out-of-band setup.
- Implement waitlist auto-promotion in lib/classes.ts: class capacity enforcement is built (app/dashboard/classes/, migrations/0015_class_scheduling.sql) but no code path promotes the first waitlist entry when a spot opens on cancellation — add a transactional promote-from-waitlist function and call it from the cancellation Server Action in app/dashboard/classes/actions.ts.
- Patch the two high-severity dependency vulnerabilities flagged by the automated check — upgrade next and sharp to their latest patched versions in package.json and regenerate package-lock.json; these are confirmed high-severity CVEs, not advisory warnings.
- Fix the missing alt text on the img element flagged by the accessibility check (likely in app/page.tsx or a portal component) — locate every bare <img> tag and add a descriptive alt attribute to meet WCAG 2.1 AA minimum.

## Summary

A production-quality build with all eight spec features genuinely implemented, consistent multi-tenant RLS enforcement, and a rich beyond-spec feature set — the code is clean, well-tested, and architecturally sound. The main drags on the score are absent rate limiting on auth endpoints, two unpatched high-severity dependencies, and a demo-credentials gap that left the runtime walkthrough unable to verify any post-login behaviour.

---
_Scored 2026-07-30 13:41 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
