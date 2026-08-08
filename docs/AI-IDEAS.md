# AI in Alpha CRM — what we took, what we built, what we deliberately did not

> **Date:** 2026-08-04.
> **Source of the ideas:** [trycompai/crm](https://github.com/trycompai/crm), an
> open-source agent-first CRM. Reviewed specifically for what transfers to *our*
> wedge — trainer-authored programs delivered to members — on a Next.js +
> Postgres-RLS, EU/GDPR stack with a 1–2 developer team.
> **Companion doc:** [`CRM-IDEAS.md`](CRM-IDEAS.md) covers the gym/fitness
> competitive scan. This one covers architecture, and is narrower on purpose.

## The verdict on the source

Its **features** are irrelevant to us: it is a single-tenant *sales* CRM
(deals/contacts/companies) on Bun + NestJS + tRPC + Turborepo with an autonomous
agent on Vercel's `eve` framework. Its **architecture** contained four ideas worth
taking, three of which are valuable even with no model involved at all — which is
how they were built here.

Notably, its single-tenant design ("no `organizationId` columns or multi-org
permission checks") is the direct opposite of our whole moat, so nothing about its
isolation model transfers.

## Taken and shipped

### 1. Evidence over confidence scores, priced by a ledger

Their rule: tools report observations with a source identifier
(`crm.signature-block`, `github.account-identity`), never a confidence score,
because "a model asked to grade its own certainty will, and it will be wrong in
the direction that makes it look useful." A ledger then prices the evidence —
strong findings write to records, weak ones become human-reviewed suggestions.

**Built as:** migration `0021_suggestions.sql`, `lib/suggestions.ts`,
`/dashboard/suggestions`. Strength is priced by `priceEvidence` from what was
observed; `createSuggestion` takes no strength argument, so a generator cannot
promote its own output. Rules in [`skills/evidence.md`](skills/evidence.md).

The adaptation that matters for us: **model and third-party sources can never be
priced strong.** That ceiling is what makes adding a model generator later a safe,
small change — it can only add things to review.

### 2. A leased work queue instead of cron

Theirs uses `claimDue` with `FOR UPDATE SKIP LOCKED` so "two dispatchers take
disjoint work and a run that dies frees its row when the lease expires", with
scheduling as each task's `dueAt` rather than a crontab.

**Built as:** migration `0020_task_queue.sql`, `lib/tasks.ts`,
`lib/task-handlers.ts`, `/api/tasks/dispatch`, a Vercel cron in `vercel.json`.

This one paid for itself immediately by fixing two live defects:

- **`notify-membership-expiry.mjs` emailed every renewing member once per day for
  seven days.** It selected every plan expiring within 7 days and recorded
  nothing, and its scheduler ran daily. The dedupe key (`<plan>:<period-end>`)
  makes at-most-once a property of the schema.
- **Waitlist promotions that failed to notify were never retried.** Migration
  0019 built the partial index `idx_class_bookings_promotion_unnotified` for "the
  notify sweep", but no sweep was ever written — notification happened only inline
  on the `cancelBooking` path, so any failure left `promotion_notified_at` null
  forever. `unnotifiedPromotions` + the `waitlist_promotion_notify` handler are
  that sweep, finally using the index 0019 created for it.

It also moved scheduled work off GitHub Actions, which has been failing on a
spending limit since 2026-07-30 — meaning the renewal reminder had, in practice,
never run at all.

### 3. Disclose capabilities up front

Their agent is told which API keys exist at session start, so it can "plan around
what it actually has rather than discovering the gaps one failed call at a time."

**Built as:** `lib/capabilities.ts`, surfaced at `/api/health`
(`capabilities`, `capability_gaps`) and as `CapabilityNotice` on the dashboard.

Generalised from the agent case to the deployment case, because we had the exact
disease in production: no `RESEND_API_KEY`, so every `sendEmail()` returns
`not_configured`, every path degrades politely, and a trainer invites a member,
sees a success message, and waits for an email that was never attempted. Each
capability now states its **consequence**, and `severity` separates "the app
cannot serve" from "a user-visible promise is silently not kept" — the second
being the dangerous class.

Email-sending task handlers now **fail loudly** rather than completing silently on
a deployment that cannot send, so the gap appears in the queue, the health probe
and the dashboard instead of nowhere.

### 4. Skills as versioned prose

Their four markdown skill files are "prose the agent reads, versioned like code".

**Built as:** [`docs/skills/`](skills/). Worth doing before any model exists
because the rules exist regardless of what produces the output, and a rule living
inside a prompt string literal is not reviewable.

## Taken as a principle, not as code

Their sandbox runs `bash`/`grep`/`glob` with deny-all egress and **no
`DATABASE_URL`**, because "a shell with credentials and egress is
exfiltration-shaped even in an internal tool."

We run no sandbox, but the principle translates directly and is recorded here as a
constraint on any future generator: **AI code paths get no privileged database
access.** They run under `withTenantContext` as the RLS-bound `app_user` role via
the tenant's identity — never `withAdminContext`, never a service-role bypass. The
queue's cross-tenant claim is the deliberate exception, and handlers immediately
narrow back to one tenant (`systemIdentity`).

## Deliberately not taken

- **The autonomous, self-scheduling agent.** Their agent runs on its own schedule
  with its own work queue and decides what to revisit. Autonomous writes into
  member health data, in the EU, maintained by 1–2 developers, is liability
  without payoff. Trainer-in-the-loop suggestions capture the value at a fraction
  of the risk — and the queue we built is the same mechanism minus the autonomy.
- **Single-tenant design.** See above; it is the inverse of our moat.
- **The stack** — Bun, NestJS, tRPC, Turborepo, Better Auth (Google-only), Prisma.
  No part of this is an improvement on one Next.js app for our team size.
- **Mailbox sync creating contacts from email threads.** Off-wedge: our members
  are invited by staff, not discovered in a mailbox.

## The model-backed generators — designed, not built

`lib/capabilities.ts` reports `ai` as `optional` and unconfigured, and no
deployment has `ANTHROPIC_API_KEY`. These are specified so that adding one is a
small change rather than a design exercise, ranked by value against our wedge:

1. **Program draft from a prompt** — "4 weeks, 3×/wk hypertrophy, knee-friendly"
   → a *draft* program. Generation must be constrained to `lib/exercise-library.ts`
   as a **closed vocabulary** so it cannot invent exercises. Highest value of the
   four: authoring is the wedge and drafting is the tedious part. Lands as a
   `program_draft` suggestion (weak, therefore reviewed) — never a saved program.
2. **Progression suggestions** — needs per-exercise set logging first
   (`ga-engagement-002`, still open). Proposes next week's loads, citing the actual
   logged sets. Weak; a trainer applies it.
3. **Brief phrasing only.** The rules and arithmetic stay in `lib/briefs.ts`. A
   model may only rewrite tone, and its involvement drops the suggestion to weak —
   which is a good trade only if phrasing turns out to matter. It probably does
   not. Lowest priority despite being the most obvious.
4. **Natural-language roster search** — compiles to a whitelisted filter DSL over
   the existing URL state. **Never** to SQL. RLS would contain the damage, but
   model-authored query text is not a surface worth opening.

### Two things to settle before any of it

- **GDPR transfer.** Sending injury notes and training history to a US model
  provider is a personal-data transfer question for an EU-hosted product with a
  Cyprus launch. Needs a DPA, a decision on which fields may leave, and member
  names pseudonymised at the boundary. This is the actual blocker, not the code.
- **Cost and failure mode.** Per-suggestion cost, and the answer to "what happens
  when the provider is down?" The capability manifest already gives the right
  answer shape: the feature is absent and says so, and rules-based suggestions —
  which need no provider — keep working. That property should not be given up for
  convenience later.
