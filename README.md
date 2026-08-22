# Alpha CRM

[![nous score](https://img.shields.io/badge/nous%20score-40%2F100-red)](docs/REPORT.md) <!-- nous-score-badge -->

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
and whenever a complete build is already there.

"Complete" is checked properly, and that distinction was itself a bug worth a
round of its own. `next start` validates `.next/BUILD_ID` and reports its absence
clearly, then opens several manifests with **no** such check — so a `.next` holding
BUILD_ID and missing one of them throws a bare `ENOENT` out of startup and exits
**with status 0**. Trusting BUILD_ID alone therefore produced the worst possible
combination: install skipped the rebuild, `npm start` reported a successful start,
the server was already dead, and nothing was ever bound to the port — which reads
to every caller as "`/` times out", not as "the build is broken". Worse, it was
sticky: BUILD_ID kept satisfying the check, so the state survived every later
install and start. That shape is ordinary — an interrupted build writes BUILD_ID
before the manifests, and a dev server killed mid-write leaves a full set of files
with a dev-shaped `routes-manifest.json` (no `dataRoutes`), which crashes
`next start` a different way. Both are now detected, named in the log, and
**rebuilt at install time**.

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

**A `next start` that dies is never reported as a success.** No preflight can
predict every unusable build — a corrupt manifest, or one from a different
Next.js version, passes any file check and still kills the server on boot — so the
guarantee is enforced on the outcome instead: `npm start` watches `next start`
until it has actually answered a request, and a server that exits without ever
answering falls back to `next dev` rather than exiting and leaving the port dark.
The confirmation is logged (`Serving the production build … confirmed answering
after 1478ms`), so "started" always means "answered at least once".
`START_PROD_FALLBACK=0` makes an unusable build a hard failure instead;
`START_PROD_READY_MS` tunes how long the confirmation waits (default 30s, against
a measured ~1.5s).

**An open port always means a usable app.** Both `npm run dev` and that fallback
run through `scripts/lib/dev-server.mjs`, which withholds the port until a request
has actually been served on it. Left alone, `next dev` binds at ~3s and cannot
render `/` for another ~14s, because dev compiles each route on its first request
— so anything that treats an open port (or `✓ Ready`) as ready starts navigating
into a 15s wait that looks exactly like a hang. Instead `next dev` is bound to an
internal loopback port, **all three entry routes** (`/`, `/login`,
`/portal/login`) are compiled there unobserved, and only then does a
byte-for-byte TCP forwarder open the public port: measured, the port opens at
~19s instead of ~3s and the first `GET /` takes **0.9s instead of 15.9s**.

The gate deliberately covers every entry route, not just `/`. Opening on `/`
alone left the login routes compiling behind an open port, so a caller that
(correctly) read "port open" as "ready" spent its first navigation to `/login`
paying that route's cold compile — which surfaces as the landing page loading
fine while both logins time out. The routes are warmed concurrently, so the
shared module graph is compiled once and gating on all three is no slower than
gating on `/` (measured cold: 18.5s, and 8.2s with a warm filesystem cache, with
`/login` and `/portal/login` answering in under a second either way). A
`Ready for QA` line marks the same moment the port opens.
`DEV_GATE=0` restores `next dev`'s bind-immediately behaviour; `DEV_WARMUP=0`
narrows the gate back to `/`.

### Demo accounts

Alpha CRM has no public signup — members are invite-only and staff are
admin-created — so the first accounts come from the seed script:

```bash
npm run migrate   # apply the schema (0005 grants the app_user role; login fails without it)
npm run seed      # create the demo gym, accounts and sample data
```

Point **both** `DATABASE_URL` *and* `MIGRATE_DATABASE_URL` at your throwaway local
Postgres first. The second one is the one people miss: `scripts/migrate.mjs` prefers
`MIGRATE_DATABASE_URL`, and `.env`/`.env.local` set it to the production host — so
exporting only `DATABASE_URL` still aims the migration at production. The runner now
prints its target and refuses a non-local one unless `ALLOW_REMOTE_MIGRATE=1` is set, so
this fails loudly instead of quietly, but it is worth knowing before you hit it.

That leaves a walkable product on first run — a gym with a trainer, a member who
already has a program assigned, the built-in exercise catalog, and all three
billing tiers:

| Role       | Sign in at      | Email                  | Password           |
| ---------- | --------------- | ---------------------- | ------------------ |
| Owner      | `/login`        | `owner@demo.local`     | `DemoOwner!2026`   |
| Trainer    | `/login`        | `trainer@demo.local`   | `DemoTrainer!2026` |
| Front desk | `/login`        | `frontdesk@demo.local` | `DemoDesk!2026`    |
| Member     | `/portal/login` | `member@demo.local`    | `DemoMember!2026`  |

Use the right entry point for the audience: staff accounts sign in at `/login`
and members at `/portal/login`. Each is rejected by the other's page, since the
session's audience comes from a verified JWT claim rather than the form.

The three staff roles are real permission boundaries, not labels. Each dashboard
route and Server Action asks for a named capability (`lib/permissions.ts`), and
Postgres enforces the sensitive half again through RLS
(`migrations/0027_front_desk_role.sql`) so a missed check in application code
cannot open it:

| Capability                      | Owner | Trainer | Front desk |
| ------------------------------- | :---: | :-----: | :--------: |
| Check-in kiosk                  |  yes  |   yes   |    yes     |
| Member records + attendance     |  yes  |   yes   |    yes     |
| Class schedule (read)           |  yes  |   yes   |    yes     |
| Class schedule (edit)           |  yes  |   yes   |     no     |
| Portal invites                  |  yes  |   yes   |     no     |
| Program builder / templates     |  yes  |   yes   |     no     |
| Data export + erasure           |  yes  |   yes   |     no     |
| Plans and payment records       |  yes  |   no    |     no     |
| Staff management                |  yes  |   no    |     no     |

A staff member who reaches a section their role does not have is redirected to
the overview with an explanation, rather than being shown an empty page.

Override any credential (or skip the demo data entirely, for a real gym) with the
`SEED_*` variables in [`.env.example`](.env.example).

### Scheduled work

Everything periodic — renewal reminders, weekly at-risk briefs, and the retry
sweep for waitlist notifications — runs on a database-backed queue
(`migrations/0020_task_queue.sql`) drained by one endpoint,
`/api/tasks/dispatch`. The schedule lives in `crons` in
[`vercel.json`](vercel.json).

**Set `CRON_SECRET` or none of it runs.** The endpoint authenticates with a
bearer token and refuses every request without one rather than defaulting to
open — an unauthenticated endpoint that emails members is an abuse primitive.
With the variable unset, tasks accumulate past their due date and nothing
happens; `/api/health` and the staff dashboard both report that gap rather than
leaving it silent. Run it by hand with:

```bash
npm run notify:expiry
```

Enqueueing is idempotent — each task is keyed by the occasion it represents — so
triggering the queue as often as you like still sends one email per renewal. That
property is the point: the previous implementation queried and emailed directly
with no record of having done so, and its daily schedule meant one member got
seven emails about one renewal.

### Needs review

Derived claims about members are never written onto the record. A member who
trained and then went quiet produces a **brief** — how long, since when, against
which program — filed in the `suggestions` ledger with the rows it was derived
from, and a trainer accepts or dismisses it at `/dashboard/suggestions`. The
decision is recorded with its author, which is what makes acting on inferred
information about someone's training defensible under GDPR.

Evidence strength is priced from what was observed, never self-reported by
whatever produced it, and model- or third-party-sourced evidence can never be
priced strong. See [`docs/skills/`](docs/skills/) for the rules and
[`docs/AI-IDEAS.md`](docs/AI-IDEAS.md) for what is deliberately not built yet.

---
_Generated by [nous](https://github.com/) — autonomous development pipeline._
