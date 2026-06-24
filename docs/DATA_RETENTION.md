# Data retention & GDPR data-subject rights

Alpha CRM launches into Cyprus (EU), so GDPR data-subject rights are a
production prerequisite. This document describes how the application supports
**data export** (right of access / portability), **erasure** (right to be
forgotten), and **retention** (storage limitation).

The behaviour described here is implemented by:

- `lib/gdpr/export.ts` — export and anonymisation logic for both subject types.
- `lib/gdpr/audit.ts` — the append-only audit trail (`gdpr_audit_event`).
- `lib/retention.ts` — pure retention-policy resolution.
- `migrations/0004_gdpr_rights.sql`, `migrations/0006_gdpr_subjects.sql` — schema,
  markers, and RLS.
- `migrations/0008_workout_logs.sql` — the member-written workout-log entity and
  its RLS (covered by export/erasure above; Phase GA).

## Data subjects

Two distinct subject types are handled symmetrically:

| Subject | Table    | Export                | Erasure                |
| ------- | -------- | --------------------- | ---------------------- |
| Member  | `member` | `exportMemberData`    | `anonymiseMember`      |
| Staff   | `users`  | `exportStaffData`     | `anonymiseStaff`       |

All access runs through the RLS-bound `app_user` role inside
`withTenantContext`, so every export/erasure is **tenant- and subject-scoped by
construction** — a cross-tenant id resolves to no row. Exports for a member
contain only that member's data; a member self-export sees only their own rows.

## Right of access / portability (export)

A data subject's personal data can be exported as a portable JSON document
(`format: alpha-crm.member-export` / `alpha-crm.staff-export`, `format_version: 1`).

- **Members** — staff fulfil a request from the member detail page
  (**Data & privacy → Export data (JSON)**). A member's own session can also
  export self-service via `exportMemberData` (the member RLS policies expose only
  their own rows). The export includes profile, assigned programs and exercises,
  and — for staff-initiated exports — status history and invites.
- **Staff** — `exportStaffData` returns the staff profile plus an activity
  summary (counts of programs/assignments/invites/status-changes they authored).

**Every export is logged** to `gdpr_audit_event` (`action = 'export'`) in the
same transaction as the reads, so an export is recorded if and only if it
succeeds.

## Right to erasure (anonymisation)

Erasure is implemented as **anonymisation, not hard deletion**. The subject row
is retained but every identifying field is tombstoned/nulled and `erased_at` is
stamped. This is deliberate:

- **Referential integrity is preserved.** Members are referenced by programs,
  assignments, invites, and status history (and staff by the rows they
  authored). Hard-deleting would violate foreign keys or cascade-delete records
  that must be kept (e.g. the audit trail itself). Anonymisation removes the
  personal data while leaving these relationships intact.
- **No cross-tenant leakage.** Erasure runs under RLS on the tenant-scoped
  client, so it can only ever affect the caller's own gym.
- **Idempotent.** Re-erasing an already-erased subject is a no-op that still
  reports success (guarded by `erased_at`).

What is scrubbed on erasure:

| Subject | Fields anonymised |
| ------- | ----------------- |
| Member  | `full_name` → `"Erased member"`, `email`/`phone`/`notes` → null, `status` → `inactive`, `auth_user_id` → null (portal access severed), pending invites revoked and invite `email` tombstoned, and the free-text `note` on every `workout_log` → null. |
| Staff   | `email` → unique tombstone, `full_name` → null, `auth_user_id` → null. |

Workout logs (`workout_log`, Phase GA) are the member's own data: they are
included in the member export (and member self-export), and on erasure their
free-text notes are scrubbed while the (now anonymised) rows are kept — they
carry only the tombstoned `member_id` plus aggregate effort/timing, preserving
referential integrity exactly like assignments and status history.

Where the subject had a portal/auth account, the Supabase auth user is deleted
(best-effort, post-commit) so they can no longer sign in. Every erasure is
logged to `gdpr_audit_event` (`action = 'erasure'`). A staff user **cannot erase
themselves** (that would remove the acting user mid-request).

The audit trail (`gdpr_audit_event`) is intentionally **not** anonymised: its
foreign keys to the subject are `ON DELETE SET NULL`, and it records *that* a
request was fulfilled (by whom, when) without retaining the exported personal
data itself.

## Retention (storage limitation) — configurable

Retention is the period a subject's personal data is kept after they become
inactive, before they become eligible for erasure. It is resolved
**most-specific-first** by `resolveRetentionDays`:

1. **Per gym** — `gym.data_retention_days` (a positive integer, or null). Set by
   an operator for a specific tenant.
2. **Platform** — the `DATA_RETENTION_DAYS` environment variable.
3. **Built-in default** — `PLATFORM_DEFAULT_RETENTION_DAYS` = **1095 days
   (3 years)**.

Invalid or absent values fall through to the next level, so a typo can never
silently disable retention. `retentionCutoff(now, days)` yields the instant
before which inactive subjects are past their window.

Retention defines **eligibility**; the erasure itself is performed via the
`anonymiseMember` / `anonymiseStaff` paths above (operator-initiated today). To
change the policy: set `DATA_RETENTION_DAYS` platform-wide, or set
`gym.data_retention_days` for a single tenant.
