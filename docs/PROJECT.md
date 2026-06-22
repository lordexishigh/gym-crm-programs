# Alpha CRM — Project Brief

> A multi-tenant web CRM for Cyprus gyms whose wedge is member-facing training programs: trainers build programs and assign them to members, who view them on a mobile-first web portal.

## Problem

Gyms and fitness businesses in Cyprus need to manage members and deliver training programs, but the incumbent (ThinkCRM) cannot give members a way to see the programs their trainers build for them. Gyms are stuck either using a generic CRM with no member-facing program delivery or stitching together separate tools. Alpha CRM closes this gap with a single hosted application that strictly isolates each gym's data while letting trainers author and assign programs that members can open on their phones.

## Target users

Primary: gym staff in Cyprus — owners and trainers — who manage their gym from a responsive web dashboard (member records, program authoring and assignment). Secondary: gym members, who use a narrow, read-only, mobile-first web portal to view the training program assigned to them by their trainer.

## Core features (MVP)

- Multi-tenant architecture: one hosted Next.js application serving many gyms, with every gym's data strictly isolated by tenant_id enforced via Postgres Row Level Security
- Identity enforced at the database layer from a signed JWT (tenant_id and user identity derived server-side, never trusted from the browser) so no member or gym can access another's data
- Staff authentication and trainer role: gym owners/trainers can log in to the responsive dashboard
- Member management UI: staff can create, view, and edit member records for their gym
- Member invite flow: members are onboarded via an invite email (no public self-signup in v1) and set up access to their portal
- Program authoring: a trainer builds a training program composed of exercises, each with sets, reps, rest, and notes
- Program assignment: a trainer assigns a built program to a specific member within their gym
- Member portal (read-only, mobile-first responsive web): an invited member logs in on their phone browser and sees the training program assigned to them

## Out of scope

- Native mobile applications (iOS/Android) — deferred until paying gyms justify the overhead
- Member self-signup (v1 uses invite email only)
- Member-side workout logging (marking sets complete, recording actual weights/reps, notes, and viewing history over time) — portal is read-only in v1
- Check-in flow
- Subscription plans and Stripe billing
- Fuller staff management (granular roles/permissions beyond owner/trainer, staff invitations, org admin tooling)
- Generic CRM functions beyond member management (deals, pipelines, marketing, reporting/analytics dashboards)
- Reusable program templates with schedules and week-over-week progression (v1 programs are point-in-time per-member plans unless specified otherwise)
- Cross-gym global member identity / linking one person to multiple tenants

## Success criteria

- A gym owner/trainer can log in to the responsive dashboard with their credentials
- A trainer can create a member record within their own gym
- A trainer can send an invite email to a member, and the member can complete sign-in to their portal from that invite
- A trainer can author a program consisting of exercises, each with sets, reps, rest, and notes, and save it
- A trainer can assign a saved program to a specific member in their gym
- An invited member can log in on a mobile phone browser and view the exact program assigned to them, rendered legibly on a small screen
- A member cannot view any data belonging to another member, and no gym's staff or members can view another gym's data — verified by attempting cross-tenant and cross-member access and being denied at the database layer
- When a member or staff query executes, the tenant/user identity used is derived from the signed JWT server-side and cannot be overridden by browser-supplied values

## Constraints

- Launch market is Cyprus (EU); the solution must operate within EU/GDPR expectations
- Member experience must ship as responsive web inside the existing Next.js app for v1 — no native iOS/Android apps
- Build order is deliberately inverted: the differentiating program feature and a thin foundation ship before generic CRM table stakes
- Strict data isolation is a hard requirement: cross-tenant or cross-member data access must be impossible by construction (enforced at the DB layer, not the application/browser layer)

## Assumptions

- Members are onboarded via invite email rather than public self-signup for v1 (stated in the idea: simpler and safer).
- Identity for every data query is enforced from the signed JWT at the database layer, never trusted from the browser (stated in the idea).
- Q1 (cross-gym identity) unanswered: a member is a brand-new, tenant-isolated record per gym in v1; there is no shared/global account linking one person across multiple gyms.
- Q2 (member logging) unanswered: the member portal is strictly read-only in v1 — members view their assigned program but do not log completed sets, weights/reps, notes, or view history.
- Q3 (auth mechanism) unanswered: after the invite, members authenticate via a password set during invite acceptance; JWT sessions are assumed to live ~24 hours before re-authentication. (To be confirmed; passwordless magic link is a viable alternative.)
- Q4 (program model) unanswered: a program in v1 is a one-off, point-in-time plan built per member, not a reusable template with scheduling or week-over-week progression.
- Q5 (data residency/GDPR) unanswered: hosting and the Postgres database are assumed to be in an EU region to satisfy GDPR/data-residency expectations for the Cyprus launch; full GDPR tooling (data export/erasure self-service, consent management) is out of scope for v1 beyond what RLS isolation and EU hosting provide.
- Q6 (billing gating access) unanswered: because billing is out of scope for v1, access is fully decoupled from any subscription/payment status; no billing-based access gating exists in the wedge release.
- The staff dashboard and the member portal are served from the same single Next.js application, differentiated by role.
- Roles in v1 are limited to gym owner/trainer (staff) and member; owner and trainer share the same dashboard capabilities unless later differentiated.
- Competitive research could not be completed because web access was not granted; the feature set was scoped from the original idea and stated positioning (member-facing programs as the wedge vs. ThinkCRM) rather than verified competitor analysis.
- Exercises are entered as free-form/manually-defined entries by the trainer in v1; there is no pre-built exercise library or media (images/video) attached to exercises.
