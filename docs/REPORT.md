# Build report — Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-55%2F100-red)](#) ![readiness](https://img.shields.io/badge/readiness-blocked-red)

**Overall: 55/100** · readiness: **blocked**

**Live:** https://gym-crm-programs.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 86 | `█████████████████░░░` |
| Code quality | 76 | `███████████████░░░░░` |
| Robustness & error handling | 62 | `████████████░░░░░░░░` |
| Builds & tests | 22 | `████░░░░░░░░░░░░░░░░` |
| UX & design | 68 | `██████████████░░░░░░` |

## Readiness checks

**Security**
- ✅ No hardcoded secrets — no secret-shaped literals found
- ✅ Secrets file ignored — .env present but gitignored
- ✅ Row-Level Security — RLS enabled on the schema
- ✅ Dependency vulnerabilities — no critical/high vulnerabilities in the last audit

**Quality**
- ✅ Automated tests — test files present
- ✅ Dependencies pinned — lockfile/requirements present
- ✅ License declared — license present
- ❌ Builds & tests pass — final product smoke test did not pass
- ⚠️ Accessibility basics — 1 <img> without alt text

**Compliance**
- ✅ Dependency licenses — no copyleft conflicts found
- ✅ Privacy policy & terms — legal page present
- ✅ Cookie consent — no analytics/trackers detected

**Growth**
- ✅ SEO & discoverability — meta tags, robots.txt and sitemap present

## Strengths

- Deep, adversarial RLS isolation testing (test/isolation-comprehensive.test.ts, test/*-rls.test.ts) that seeds conflicting tenants and asserts forged cross-tenant writes are blocked, not just happy-path reads.
- GDPR export/erasure implemented as real tenant-scoped transactional logic (lib/gdpr/export.ts) with defined tombstone semantics and an audit trail, not a stub.
- Invite-only onboarding is genuinely enforced (app/invite/accept flow, lib/invites.ts) with no public signup route present in the tree, matching the v1 spec constraint.
- Self-documenting risk notes captured in memory/ (e.g. test-db-points-at-production.md) show the build caught and fixed a real hazard — .env pointing at production Supabase — via a vitest setupFile guard.

## To improve

- Builds & tests pass: final product smoke test did not pass
- The final product smoke test fails despite every individual task and most test suites reporting green — root-cause the smoke test failure (likely an integration/env issue between the many late-added routes like /api/email/webhook, /portal/programs/[id], and /dashboard/templates) before trusting any of the per-task 'build succeeds' claims.
- Fix the outstanding accessibility WARN: locate the <img> missing alt text (likely in a dashboard or portal view not covered by test/a11y.test.ts, since that suite only renders ProgramView, MemberForm, ProgramBuilder, and ExerciseLibraryGrid) and add coverage for the remaining pages.
- Migration ordering is ambiguous — three separate files share the '0003_' prefix (0003_assignment_lifecycle.sql, 0003_library_and_templates.sql, 0003_member_extended_fields.sql); renumber sequentially so scripts/migrate.mjs applies them in a deterministic, reviewable order and the smoke-test failure can't stem from migration race conditions.
- Several task summaries mention prior submissions where 'view-layer files existed on disk but were never committed' or were 'stale' snapshots (mvp-member-portal, alpha-invite-lifecycle) — add a CI check that fails the pipeline if `git status` shows uncommitted tracked-file diffs at task completion, since this class of bug is exactly what would produce a passing per-task report but a failing final smoke test.

## Summary

Feature-complete and well-tested at the unit/integration level with genuinely strong multi-tenant isolation and GDPR logic, but the build fails its final smoke test — a hard verification gate that outweighs the optimistic per-task narratives and must be root-caused before this is shippable.

---
_Scored 2026-07-22 22:00 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
