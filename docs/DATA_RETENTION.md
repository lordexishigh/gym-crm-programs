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
- `migrations/0025_member_tasks.sql` — the staff follow-up task entity and its
  RLS (covered by export/erasure above).
- `migrations/0021_suggestions.sql` — the derived-claim ledger; its headline
  text is scrubbed on erasure (below).

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
| Member  | `full_name` → `"Erased member"`, `email`/`phone`/`notes` → null, `status` → `inactive`, `auth_user_id` → null (portal access severed), pending invites revoked and invite `email` tombstoned, the free-text `note` on every `workout_log` → null, the free-text `title` on every `member_task` → `"[erased]"`, the free-text `headline` on every `suggestions` row about the member → `"[erased]"`, and the member's own `reason` on any `member_deletion_request` → null. |
| Staff   | `email` → unique tombstone, `full_name` → null, `auth_user_id` → null. |

Workout logs (`workout_log`, Phase GA) are the member's own data: they are
included in the member export (and member self-export), and on erasure their
free-text notes are scrubbed while the (now anonymised) rows are kept — they
carry only the tombstoned `member_id` plus aggregate effort/timing, preserving
referential integrity exactly like assignments and status history.

Follow-up tasks (`member_task`, CRM-IDEAS "Apply now" #5) are a staff-internal
controller record, not member-facing data — like status history and invites,
they are included only in a **staff-initiated** export, never a member
self-export (member RLS policies do not expose `member_task` at all). Their
free-text `title` may name PII about the member, so it is scrubbed on erasure
exactly like workout-log notes; the (now anonymised) task rows are kept.

Derived-claim suggestions (`suggestions`, migration 0021 — at-risk briefs
today, and whatever future generator writes here) are staff-internal
deliberations and are not exposed to members under RLS at all, so they are
never part of any export. Their `headline` is not a label — it is built by
interpolating the member's full name directly into a sentence (`"$NAME has
not trained in N days…"`, `buildAtRiskBrief` in `lib/briefs.ts`), so a
suggestion filed before erasure keeps naming an "erased" member forever unless
scrubbed. Erasure now tombstones `headline` on every suggestion about the
member (regardless of status — pending, accepted, dismissed, or superseded);
`detail`/`evidence` are left as-is since today's only generator (at-risk
briefs) never writes the member's name into them, only program names and
dates.

Where the subject had a portal/auth account, the Supabase auth user is deleted
(best-effort, post-commit) so they can no longer sign in. Every erasure is
logged to `gdpr_audit_event` (`action = 'erasure'`). A staff user **cannot erase
themselves** (that would remove the acting user mid-request).

The audit trail (`gdpr_audit_event`) is intentionally **not** anonymised: its
foreign keys to the subject are `ON DELETE SET NULL`, and it records *that* a
request was fulfilled (by whom, when) without retaining the exported personal
data itself.

### Erased members disappear from staff-facing lists

An erased member's row survives (see above) but holds no personal data, so it is
filtered out of every staff-facing list rather than shown as a tombstone: the
roster and its count (`memberRosterWhere`, `lib/members.ts` — unconditional, not
a UI filter the dashboard can switch off), the overview member counts
(`lib/dashboard.ts`), the program assignment picker and assigned-members list,
the "needs review" suggestion queue, the check-in desk feed, and the invitable
list on `/dashboard/invites`.

The record stays reachable at `/dashboard/members/[id]`, which is where the
erasure is evidenced — and there it is **read-only**. Every write path that
would put personal data back into it refuses an erased member server-side
(`updateMemberAction`, `uploadMemberPhotoAction`, `regeneratePinAction`,
`sendInviteAction`), and the corresponding controls are withheld from the page.
UI-only denial would leave the Server Actions reachable, so both halves exist.

## Member-initiated erasure requests

A member does not have to ask out of band. The portal's **Your data** card
(`app/portal/DataPrivacy.tsx`) lets the data subject file a request themselves;
it lands in `member_deletion_request` (migration 0026) and appears for staff at
**/dashboard/deletion-requests**, oldest first — the one-month response deadline
(Art. 12(3)) runs from the request date — and as a quick action on the overview
whenever the queue is non-empty.

Two outcomes, both recorded to `gdpr_audit_event` with the deciding user:

- **Confirm** → `anonymiseMember` runs, the request is marked `completed`, and
  the member is emailed a confirmation. The contact address is read **before**
  the erasure and used after it commits — reading it afterwards would find a
  tombstone and the subject would never be told. This is also why migration 0026
  stores no copy of the address: it only has to survive one function call.
  Whether the send landed is recorded in `confirmation_email`
  (`sent` / `failed` / `skipped`), which is the controller's evidence of having
  notified them; on a deployment with no mail provider the page warns staff up
  front that they must tell the member themselves.
- **Decline** → a reason is **required** (a refusal the subject is given no
  reason for is not a lawful refusal) and is shown back to them in the portal.
  Art. 17(3) leaves lawful grounds to refuse, e.g. a statutory retention period.

Isolation is RLS, not application code: a member may insert only a `pending`
request for `app_current_member()` with no decision pre-filled, may read only
their own, and has **no** UPDATE/DELETE policy — once filed, the request is the
controller's record. A partial unique index allows one `pending` row per member,
so a double tap reports the existing request instead of queuing duplicate work.

The request row deliberately **outlives** the erasure it triggers: it is the
evidence that a subject request was received and answered inside the statutory
window. Only the member's own `reason` prose is scrubbed.

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
