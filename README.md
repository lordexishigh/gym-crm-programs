# Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-70%2F100-yellow)](docs/REPORT.md) <!-- nous-score-badge -->

> A multi-tenant web CRM for Cyprus gyms whose wedge is member-facing training programs: trainers build programs and assign them to members, who view them on a mobile-first web portal.

Gyms and fitness businesses in Cyprus need to manage members and deliver training programs, but the incumbent (ThinkCRM) cannot give members a way to see the programs their trainers build for them. Gyms are stuck either using a generic CRM with no member-facing program delivery or stitching together separate tools. Alpha CRM closes this gap with a single hosted application that strictly isolates each gym's data while letting trainers author and assign programs that members can open on their phones.

## Tech stack

- **Language:** TypeScript
- **Backend:** Next.js (App Router) Route Handlers + Server Actions / TypeScript
- **Frontend:** Next.js / React / TypeScript (responsive, mobile-first member portal) with Tailwind CSS
- **Database:** PostgreSQL 16 with Row Level Security
- **Deployment:** Vercel (EU) + Supabase (managed Postgres + Auth, EU region)
- **External services:** Supabase Auth (JWT identity), Resend (transactional email for invites)

## Core features

- Multi-tenant architecture: one hosted Next.js application serving many gyms, with every gym's data strictly isolated by tenant_id enforced via Postgres Row Level Security
- Identity enforced at the database layer from a signed JWT (tenant_id and user identity derived server-side, never trusted from the browser) so no member or gym can access another's data
- Staff authentication and trainer role: gym owners/trainers can log in to the responsive dashboard
- Member management UI: staff can create, view, and edit member records for their gym
- Member invite flow: members are onboarded via an invite email (no public self-signup in v1) and set up access to their portal
- Program authoring: a trainer builds a training program composed of exercises, each with sets, reps, rest, and notes
- Program assignment: a trainer assigns a built program to a specific member within their gym
- Member portal (read-only, mobile-first responsive web): an invited member logs in on their phone browser and sees the training program assigned to them

## Getting started

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for how to install dependencies,
run, and verify the project. Architecture is documented in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the build plan is in
[`docs/PLAN.md`](docs/PLAN.md).

`.next/` is not committed, so **`npm install` builds it for you** — see
[`scripts/postinstall.mjs`](scripts/postinstall.mjs). Install is the only moment when
waiting for a build is free: no port is open yet, so the ~1 minute is invisible. Do the
same work during `npm start` and that minute is a port that black-holes every
connection. Measured here, from a fresh clone:

| checkout state | time to a served `/` |
| --- | --- |
| production build present (`next start`) | **0.2s** |
| no build (`next dev` fallback) | **20s** |

That 20s is the first webpack/Turbopack compile, which `next dev` pays on the first
request to a route and which no amount of readiness-gating can remove. It lands
exactly on the 20s budget a QA harness gives a navigation, so the unbuilt path was a
coin flip that reported the whole app as unreachable whenever it lost. The build now
exists before anything is served. Skip it with `ALPHA_SKIP_BUILD=1` (CI does — it
builds in its own step); it also skips itself on Vercel, which builds after installing,
and whenever `.next/BUILD_ID` is already there.

`npm start` stays usable if that build never happened (`--ignore-scripts`, a warm
node_modules cache). Plain `next start` would exit and leave the
port unbound, and a client reaching it through a forwarded port, container or proxy
does not get a connection error for an unbound port — the SYN is black-holed, so
every route simply hangs and the whole product reads as unreachable. Building first
is no better from the outside: it takes ~85s here, and the port is unbound for all
of them. So a missing build falls back to **`next dev`**, which serves the real
pages (more slowly) far sooner, announced loudly on startup. Set
`START_AUTOBUILD=0` to make a missing build a hard failure instead. `npm start`
also refuses to start onto a port another process already holds, naming that
process, so a run can never quietly probe an orphaned server that is still
serving an older build.

**An open port always means a usable app.** Both `npm run dev` and that fallback
run through `scripts/lib/dev-server.mjs`, which withholds the port until a request
has actually been served on it. Left alone, `next dev` binds at ~3s and cannot
render `/` for another ~14s, because dev compiles each route on its first request
— so anything that treats an open port (or `✓ Ready`) as ready starts navigating
into a 15s wait that looks exactly like a hang. Instead `next dev` is bound to an
internal loopback port, `/` is compiled there unobserved, and only then does a
byte-for-byte TCP forwarder open the public port: measured, the port opens at
~19s instead of ~3s and the first `GET /` takes **0.9s instead of 15.9s**. The
remaining entry routes (`/login`, `/portal/login`) warm behind the open port, and
a `Ready for QA` line marks when all three are done. `DEV_GATE=0` restores
`next dev`'s bind-immediately behaviour.

### Demo accounts

Alpha CRM has no public signup — members are invite-only and staff are
admin-created — so the first accounts come from the seed script:

```bash
npm run migrate   # apply the schema (0005 grants the app_user role; login fails without it)
npm run seed      # create the demo gym, accounts and sample data
```

That leaves a walkable product on first run — a gym with a trainer, a member who
already has a program assigned, the built-in exercise catalog, and all three
billing tiers:

| Role    | Sign in at       | Email                | Password           |
| ------- | ---------------- | -------------------- | ------------------ |
| Owner   | `/login`         | `owner@demo.local`   | `DemoOwner!2026`   |
| Trainer | `/login`         | `trainer@demo.local` | `DemoTrainer!2026` |
| Member  | `/portal/login`  | `member@demo.local`  | `DemoMember!2026`  |

Use the right entry point for the audience: staff accounts sign in at `/login`
and members at `/portal/login`. Each is rejected by the other's page, since the
session's audience comes from a verified JWT claim rather than the form.

Owner vs. trainer is a real permission boundary, not a label — billing and plan
management are owner-only and a trainer is redirected away from them.

Override any credential (or skip the demo data entirely, for a real gym) with the
`SEED_*` variables in [`.env.example`](.env.example).

---
_Generated by [nous](https://github.com/) — autonomous development pipeline._
