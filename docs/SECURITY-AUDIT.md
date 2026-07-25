# Security & RLS Isolation Audit (Beta)

Task: **Comprehensive security and RLS isolation audit** (beta-isolation-audit).
Scope: tenant/member isolation enforced by Postgres Row Level Security, and the
auth / JWT / token-handling paths that feed identity into it.

Strict isolation is a hard, by-construction requirement. This document records
the audit's findings, what was verified, what was remediated, and how the
guarantee is now continuously enforced in CI.

---

## 1. Threat model & the isolation boundary

Every tenant's data lives in one Postgres database, isolated by `tenant_id` and
enforced by RLS — **not** by application `WHERE` clauses. The trust chain:

1. A Supabase-issued **access token (JWT)** is verified server-side
   (`lib/identity.ts`). Its claims (`tenant_id`, `app_role`, `member_id`) are
   read **only** from the verified payload.
2. The derived identity is pushed into transaction-local GUCs and the connection
   drops to the unprivileged, RLS-bound `app_user` role (`lib/db.ts`
   `withTenantContext`).
3. RLS policies (migrations `0002`/`0003`/`0004`/`0006`) read those GUCs via
   `app_current_tenant()` / `app_current_role()` / `app_current_member()` and
   make cross-tenant and cross-member rows invisible / unwritable.

The security boundary is therefore the **database**: even a buggy query that
forgets a tenant predicate cannot leak across the boundary.

---

## 2. Findings

### 2.1 Remediated — JWT algorithm not pinned (hardening)

**Finding.** `verifyAccessToken` validated the JWKS signature, issuer, and
audience, but did not constrain the accepted signing algorithm. Resolving the
key by `kid` already prevents the classic public-key-as-HMAC-secret confusion,
but relying on that alone is fragile: it leaves the door open to an
algorithm-substitution attempt (`alg: none`, an unexpected `alg: HS256`, or a
key type the project does not actually publish).

**Remediation.** `jwtVerify` is now called with `algorithms: ["ES256"]` — the
project's asymmetric signing algorithm (per the Supabase modern-auth standard).
Any token presenting another `alg` is rejected outright.
Covered by `test/identity.test.ts` ("rejects a token whose alg is not ES256").

### 2.2 Verified — no code path trusts client-supplied identity

Audited every Server Action (`app/**/actions.ts`) and data module
(`lib/{members,programs,assignments,templates,exercise-library,portal,staff,gdpr/*}`).
**Every** `tenant_id` written or filtered on comes from `session.identity`
(derived from the verified token) or, in the pre-session invite-acceptance flow,
from the server-side token-hash lookup (`invite.tenantId`). There is **no**
`formData.get("tenant_id" | "role" | "member_id")` anywhere (grep-confirmed).
`member_id` / `app_role` likewise originate only from verified claims.

### 2.3 Verified — tokens are verified, scoped, and expirable

- **Verified:** asymmetric ES256 against the project JWKS; issuer + audience
  checked; no shared secret stored (`SUPABASE_JWT_SECRET` is not used).
- **Scoped:** member claims (`app_role`, `tenant_id`, `member_id`) are written
  into GoTrue `app_metadata` at provisioning (`lib/auth/admin.ts`), which the
  end user cannot edit; they ride inside the signed token.
- **Expirable:** `jwtVerify` enforces `exp` by default (short-lived access
  token); refresh is handled in edge middleware; the refresh token bounds the
  session to `SESSION_MAX_AGE_SECONDS` (30 days).
  Covered by `test/identity.test.ts` ("rejects an expired token", "wrong
  audience").

### 2.4 Verified — invite tokens

`lib/invites.ts` / `lib/invite-acceptance.ts` / `app/invite/accept/actions.ts`:

- 256-bit (`randomBytes(32)`) base64url token; only its **SHA-256 hash** is
  stored (`invite.token_hash`) — a leaked DB row cannot be reversed to a link.
- **Single-use:** acceptance flips the row with a conditional
  `... where status = 'pending'`; a concurrent winner makes the UPDATE match no
  row and the just-created auth user is rolled back / deleted.
- **Expirable:** `expires_at` (7-day TTL) checked on lookup; a lazy sweep also
  flips stale rows to `expired`.
- **Scoped:** the invite row carries `tenant_id` + `member_id`; acceptance binds
  exactly that member.
- The pre-session lookup deliberately uses the RLS-bypassing admin path — gated
  by possession of the unguessable raw token (documented in the module).

### 2.5 Verified — session cookies

`lib/auth/cookies.ts`: access + refresh tokens are stored `httpOnly`,
`sameSite=lax`, `secure` in production, `path=/`. Identity is always re-derived
by verifying the access token (`getSession`) — the cookie value is never trusted
as identity.

### 2.6 Verified — `withAdminContext` (RLS-bypass) callers are intentional

The RLS-bypassing path is reachable only from: gym/account provisioning, the
pre-session invite-token lookup (`lib/invite-acceptance.ts`), invite acceptance
(`app/invite/accept/actions.ts`), and the signature-authenticated Resend
delivery webhook (`lib/email/delivery.ts`). None accept a client-supplied
`tenant_id`; each is documented as a deliberate cross-tenant/no-session path. No
normal request handling routes through it.

### 2.7 Verified — RLS coverage is complete across all tenanted tables

All 12 tenanted tables have RLS **enabled + forced** and at least one policy:
`gym`, `users`, `member`, `invite`, `program`, `exercise`,
`program_assignment`, `exercise_library`, `program_template`,
`template_exercise`, `member_status_event`, `gdpr_audit_event`.

The migration-ordering risk (three `0003_*` files, plus `0004`/`0006`) was
checked: each table is created **and** given RLS in the same migration, and all
sort after `0002` (which defines the `app_current_*()` helpers they reference),
so apply order is safe. The `gdpr_audit_event` member self-insert policy is
correctly constrained (export-only, self-subject, no staff subject — `0006`).

### 2.8 Remediated — test harness could silently target a remote/production DB

**Finding.** The RLS isolation suites SEED and MUTATE real rows (two conflicting
tenants and their full child trees, plus forged-write attempts). They select the
database from `DATABASE_URL`. Because `scripts/migrate.mjs` does
`import "dotenv/config"`, simply importing it — which every DB-backed test does —
loads `.env`, and locally `.env` carries the **production** Supabase connection
string. A developer running `npm test` on their machine would therefore seed
production (observed: multiple `Audit Gym A`/`Audit Gym B` fixture trees created
in the live DB). CI was never affected — it sets `DATABASE_URL` to a throwaway
`postgres:16` in the workflow env, a value dotenv leaves untouched — but the
local foot-gun is real and the seeding is destructive-adjacent.

**Remediation.**
- **Guard (`test/setup/db-safety.ts`, wired as a vitest `setupFile`).** Before
  any test module is imported, it resolves `.env` the same way the runner does
  and, unless `DATABASE_URL` points at a local host (`localhost`/`127.0.0.1`/
  `::1`) or the operator sets `ALLOW_NONLOCAL_TEST_DB=1`, it blanks
  `DATABASE_URL`/`MIGRATE_DATABASE_URL`. The DB suites' existing `hasDb` guards
  then SKIP instead of running against a remote target. (Setting the vars to `""`
  rather than deleting them ensures the later `dotenv/config` import cannot
  repopulate them — dotenv never overrides a key already present.)
- **Self-cleanup.** `isolation-comprehensive.test.ts` now deletes its two seeded
  gyms in `afterAll` (cascading to every child row), so even a deliberate
  `ALLOW_NONLOCAL_TEST_DB=1` run against a shared DB leaves no residue.
- The pre-existing `Audit Gym A`/`Audit Gym B` rows left in the live DB by prior
  runs are removable with a single statement (children cascade):
  `delete from gym where name in ('Audit Gym A', 'Audit Gym B');`

---

## 3. Continuous enforcement (tests + CI gate)

Isolation is now **exhaustively and continuously** verified, not assumed:

- **`test/isolation-coverage.test.ts`** — a catalog-driven matrix that
  *discovers* every tenanted table (any table with a `tenant_id` column, plus
  `gym`) and asserts RLS is enabled + forced and ≥1 policy exists. A future
  tenanted table shipping without RLS fails CI by construction.
- **`test/isolation-comprehensive.test.ts`** — two fully-populated, conflicting
  tenants and three members. For every tenanted table it asserts a foreign
  staff session cannot SELECT / UPDATE / DELETE another tenant's rows nor INSERT
  a forged-tenant row; and that members read only their own rows, cannot read
  any staff-only table, cannot write the member table, cannot write any
  staff-managed table they can partly read (INSERT/UPDATE/DELETE on
  program/exercise/program_assignment — including the self-assign
  privilege-escalation attempt — all fail), and can only self-insert the one
  permitted `gdpr_audit_event`. All probes run through the real
  `withTenantContext` session/role path (never a superuser bypass), and the
  suite self-cleans its seed in `afterAll`.
- **`test/identity.test.ts`** — JWT verification unit tests (tampered, wrong
  alg, expired, wrong audience, client-untrusted identity derivation).
- Plus the pre-existing per-feature RLS suites.

**CI gate.** `npm test` runs the whole suite against a fresh `postgres:16` on
every push and pull request (`.github/workflows/ci.yml`). `deploy.yml` now has a
`test` job that runs type-check + migrations + the full suite against a fresh
database, and `migrate-and-deploy` declares `needs: test` — so **no deploy
proceeds unless the isolation audit is green**.

---

## 4. Dependency vulnerability audit (`npm audit`)

Audited 2026-07-25 against the npm advisory database. Result with the pins
below in place — the exact zero-high/critical evidence:

```
$ npm audit
found 0 vulnerabilities
```

(`npm audit --json` metadata: `info 0, low 0, moderate 0, high 0, critical 0`
across 263 resolved packages.)

### 4.1 `next` — pinned to `^15.5.21` (lockfile resolves 15.5.21)

15.5.21 is the **minimum** version clearing every published advisory on the
15.x line; the most recent batch is fixed *exactly* in 15.5.21, so nothing
lower passes audit:

Advisories are identified by their GHSA slug (the npm advisory database's
primary identifier); consult each linked advisory for any CVE assignment.

| Advisory | Severity | Fixed in |
| --- | --- | --- |
| [GHSA-89xv-2m56-2m9x](https://github.com/advisories/GHSA-89xv-2m56-2m9x) — SSRF in Server Actions on custom servers | high | **15.5.21** |
| [GHSA-m99w-x7hq-7vfj](https://github.com/advisories/GHSA-m99w-x7hq-7vfj) — DoS in App Router using Server Actions | high | **15.5.21** |
| [GHSA-p9j2-gv94-2wf4](https://github.com/advisories/GHSA-p9j2-gv94-2wf4) — SSRF in rewrites via attacker-controlled destination | high | **15.5.21** |
| [GHSA-26hh-7cqf-hhc6](https://github.com/advisories/GHSA-26hh-7cqf-hhc6) — middleware/proxy bypass via segment-prefetch routes (incomplete-fix follow-up) | high | 15.5.18 |
| [GHSA-492v-c6pp-mqqv](https://github.com/advisories/GHSA-492v-c6pp-mqqv) — middleware/proxy bypass via dynamic route parameter injection | high | 15.5.16 |
| [GHSA-c4j6-fc7j-m34r](https://github.com/advisories/GHSA-c4j6-fc7j-m34r) — SSRF via WebSocket upgrades | high | 15.5.16 |
| [GHSA-267c-6grr-h53f](https://github.com/advisories/GHSA-267c-6grr-h53f) — middleware/proxy bypass via segment-prefetch routes | high | 15.5.16 |
| [GHSA-mg66-mrh9-m8jx](https://github.com/advisories/GHSA-mg66-mrh9-m8jx) — DoS via connection exhaustion (Cache Components) | high | 15.5.16 |
| [GHSA-9qr9-h5gf-34mp](https://github.com/advisories/GHSA-9qr9-h5gf-34mp) — RCE in React flight protocol | **critical** | 15.5.7 |

(Plus the moderate/low 15.5.21-fixed advisories GHSA-68g3-v927-f742,
GHSA-4633-3j49-mh5q, GHSA-4c39-4ccg-62r3, GHSA-955p-x3mx-jcvp — all cleared by
the same pin.)

### 4.2 `sharp` — override `^0.35.3` (lockfile resolves 0.35.3)

`sharp` is an optional dependency of `next` (image optimization), so it is not
a direct dependency; the `overrides` entry in `package.json` forces the
resolved version wherever it installs:

| Advisory | Severity | Fixed in |
| --- | --- | --- |
| [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) — inherited libvips vulnerabilities | high | 0.35.0 |

The override (`0.35.3` in the lockfile) sits above the 0.35.0 fix boundary.

Note: `overrides` changes only take effect on a clean install
(`rm -rf node_modules && npm install` / `npm ci`), not an incremental one.

---

## 5. Residual notes / future hardening

- Edge middleware gates protected paths coarsely (valid token → proceed); exact
  role-vs-path enforcement is in the route layouts (`requireStaff` /
  `requireMember`) and, ultimately, RLS. A member token reaching `/dashboard`
  is redirected, and would see no staff data even if it weren't. Acceptable.
- If Supabase ever rotates signing keys to RS256, update the pinned
  `algorithms` list in `lib/identity.ts` accordingly.
