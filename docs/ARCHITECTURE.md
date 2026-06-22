# Architecture

A single multi-tenant Next.js (App Router) application hosts both the staff/trainer dashboard and the mobile-first member portal, backed by a single PostgreSQL database where every tenant's data is isolated by tenant_id enforced via Row Level Security. Identity is carried in a signed JWT whose tenant_id and user claims are derived server-side and pushed into the database session on every request, so RLS policies — not application code — make cross-tenant and cross-member access impossible by construction. Hosting and data reside in the EU to meet GDPR expectations.

## Tech stack

- **Language:** TypeScript
- **Backend:** Next.js (App Router) Route Handlers + Server Actions / TypeScript
- **Frontend:** Next.js / React / TypeScript (responsive, mobile-first member portal) with Tailwind CSS
- **Database:** PostgreSQL 16 with Row Level Security
- **Deployment:** Vercel (EU) + Supabase (managed Postgres + Auth, EU region)
- **External services:** Supabase Auth (JWT identity), Resend (transactional email for invites)

## Components

### Next.js Application (backend)

- **Tech:** Next.js 15 (App Router) / React / TypeScript
- Single deployable that serves both the staff/trainer dashboard and the read-only member portal, and contains all server-side logic (Route Handlers and Server Actions). It validates the signed JWT on every request, derives tenant_id/user_id server-side, opens a transaction-scoped DB connection with those identity claims set, and never trusts identity from the browser.
- **Exposes:** HTTPS web UI (staff dashboard + member portal), Route Handlers / Server Actions (members, programs, assignments, invites)
- **Depends on:** PostgreSQL (RLS), Identity & Auth (Supabase Auth), Transactional Email
### Staff Dashboard (frontend)

- **Tech:** React / TypeScript (Next.js Server + Client Components), Tailwind CSS
- Responsive dashboard for gym owners/trainers to authenticate, manage member records (create/view/edit), author training programs (exercises with sets, reps, rest, notes), assign programs to members within their gym, and send member invites. Logical unit within the Next.js app.
- **Depends on:** Next.js Application
### Member Portal (frontend)

- **Tech:** React / TypeScript (Next.js, mobile-first responsive), Tailwind CSS
- Read-only, mobile-first responsive web experience where an invited member logs in on their phone browser and views the training program assigned to them. Logical unit within the same Next.js app — no separate deployable in v1.
- **Depends on:** Next.js Application
### PostgreSQL (RLS) (database)

- **Tech:** PostgreSQL 16 (Row Level Security), EU region
- Single multi-tenant relational database. Every tenant-scoped table carries tenant_id and is protected by Row Level Security policies that read identity from the request's JWT claims / session GUCs (e.g. tenant_id and member_id). Members can only ever read their own assigned program; staff can only access rows for their own gym. Isolation is enforced here, not in application code.
- **Exposes:** SQL (RLS-protected, identity-scoped sessions)
### Identity & Auth (service)

- **Tech:** Supabase Auth (Postgres-native JWT, custom claims via access-token hook), EU region
- Issues and verifies signed JWTs for staff and members, supports email-based invite onboarding (no public self-signup in v1), and embeds a custom tenant_id claim (and role) used by Postgres RLS. The Next.js app maps the verified token to DB session identity on every request.
- **Exposes:** Sign-in / session JWT issuance, Invite-based user provisioning, JWT verification (JWKS)
- **Depends on:** PostgreSQL (RLS)
### Transactional Email (service)

- **Tech:** Resend (EU-region sending)
- Sends member invite emails and password/access setup links. Triggered server-side when a trainer invites a member.
- **Exposes:** Send transactional email API
### Hosting & Infrastructure (infrastructure)

- **Tech:** Vercel (Next.js, EU region) + Supabase (managed Postgres + Auth, EU/Frankfurt)
- Hosts the Next.js application and managed Postgres/Auth in an EU region for GDPR data residency, with TLS, secrets management, and automated database backups.
- **Exposes:** Public HTTPS endpoint, Managed Postgres + backups
- **Depends on:** Next.js Application, PostgreSQL (RLS), Identity & Auth

## Data models

- Gym (Tenant)
- User (Staff/Trainer)
- Member
- Invite
- Program
- Exercise
- ProgramAssignment

## API design

Next.js Route Handlers and Server Actions over HTTPS, organized by resource and always scoped server-side by the JWT-derived tenant_id (never a client-supplied tenant). Representative operations: auth/session (sign-in, accept-invite), members (POST/GET/PATCH /members), programs (POST/GET/PATCH /programs with nested exercises), assignments (POST /assignments, GET /me/program for the member portal), and invites (POST /invites to trigger onboarding email). Every database call runs inside a transaction that first sets the identity claims so RLS policies apply; no endpoint can read or write across tenants even if application logic is buggy.

## Key decisions

- Single Next.js app for both staff dashboard and member portal — matches the stated preference, avoids a second deployable in v1, and lets the responsive member portal ship without native apps.
- PostgreSQL Row Level Security as the isolation boundary — the hard requirement is 'impossible by construction at the DB layer', so isolation lives in RLS policies keyed on JWT claims rather than in application filters that can be forgotten.
- Identity derived server-side from a signed JWT and injected into the DB session — the browser never supplies tenant_id/user_id; the verified token's claims drive both authorization and RLS.
- Supabase chosen for managed Postgres + Auth — it provides Postgres-native JWTs with custom claims, RLS as a first-class pattern, and invite-based provisioning, which is the simplest proven stack that satisfies DB-layer identity and EU data residency for a 1-2 developer team.
- Resend for transactional invite email — simple, well-documented API for the only outbound email the v1 invite flow requires.
- EU-region hosting/data (Vercel EU + Supabase Frankfurt) — required for GDPR expectations in the Cyprus launch market.
- Build order honors the inverted plan — program authoring/assignment and the thin RLS+auth foundation are the first deliverables; generic CRM breadth is deferred.

## Performance

The member portal is consumer-facing and opened on phones over mobile data, so
it is held to an explicit mobile performance budget (beta-polish-a11y-002). The
budget is the Google "good" Core Web Vitals boundary — a metric at or below its
target is within budget:

| Metric | Budget | What it guards |
| --- | --- | --- |
| LCP (Largest Contentful Paint) | ≤ 2500 ms | Main content visible quickly |
| INP (Interaction to Next Paint) | ≤ 200 ms | Taps feel responsive |
| CLS (Cumulative Layout Shift) | ≤ 0.1 | No major layout shift / jank |
| FCP (First Contentful Paint) | ≤ 1800 ms | First pixels paint quickly |
| TTFB (Time to First Byte) | ≤ 800 ms | Server responds quickly |

These thresholds are defined once in `lib/observability/web-vitals.ts` and shared
by the client reporter. How the budget is kept and verified:

- **Thin server-rendered surface.** Portal pages (`app/portal/*`) are Server
  Components with no client data-fetching and no heavy client libraries, so the
  shipped JS stays small. The only client JS is the logout form and the
  `<WebVitals />` reporter (renders nothing).
- **Transfer trimming** (`next.config.mjs`): gzip/brotli compression, no client
  source maps in production, and the `X-Powered-By` header dropped.
- **No layout shift / jank**: content renders from server data in one pass, and
  `prefers-reduced-motion` neutralises transitions/animations (`app/globals.css`).
- **Continuous verification**: `<WebVitals />` measures real Core Web Vitals via
  Next's `useReportWebVitals` and forwards *only budget breaches* through the
  existing `/api/observability/report` pipeline, where they are captured as
  `warning`-severity monitoring events. A regression therefore shows up as a
  monitored alert rather than going unnoticed.

## Assumptions

- Scale is modest in v1: tens of gyms and low thousands of members, comfortably served by a single shared Postgres instance with RLS (no per-tenant database/sharding needed).
- Team is 1-2 developers, favoring a managed BaaS (Supabase + Vercel) over self-hosted infrastructure.
- Member portal is strictly read-only in v1 (members only view assigned programs; no logging, comments, or progress tracking yet).
- No public self-signup — all members and presumably staff are provisioned via invite/admin, so the auth surface is small.
- Each member belongs to exactly one gym; staff belong to exactly one gym; no cross-gym users in v1.
- A program is assigned to a single member (or copied per member); shared/templated programs across members are not required in v1.
- Custom tenant_id (and role) claims can be added to the issued JWT and read by Postgres RLS (via Supabase access-token hook / session GUC), and all data access flows through identity-scoped sessions.
- Competitive research could not be completed (web access was blocked at design time); the stack reflects the stated preferences and common patterns in gym/training-program SaaS rather than verified competitor stack data — see risks.

## Risks

- RLS correctness is the entire security model — a missing or misconfigured policy, a table with RLS disabled, or a privileged service-role connection bypassing RLS would silently break tenant isolation; policies need explicit deny-by-default and automated tests for cross-tenant access.
- Any server code path using a privileged/service-role DB connection (e.g. for invites or admin tasks) bypasses RLS and must be tightly contained and audited.
- Reliably propagating JWT claims into the DB session for every request (including Server Actions, background/email tasks, and connection-pooled queries) is essential; transaction pooling can leak session GUCs if not reset per transaction.
- GDPR obligations beyond data residency (data subject access/erasure, consent, processor agreements with Vercel/Supabase/Resend) must be designed in, not bolted on.
- Invite-flow email deliverability and token security (expiry, single-use, no account enumeration) are critical to safe onboarding.
- Lack of verified competitor research means table-stakes member-portal expectations may be under-scoped; revisit once web research can be run.
