# Alpha CRM — Competitive Ideas & Prioritized Roadmap

> **For:** Product owner, morning review.
> **Date:** 2026-06-25. **Partially superseded — see the status note below.**
> **Companion doc:** [`AI-IDEAS.md`](AI-IDEAS.md) (2026-08-04) covers the
> architecture ideas taken from an agent-first CRM, and what shipped from them.

## Status note (added 2026-08-04)

Two things in this document are now out of date, and one of them is a reversal
rather than a delay — worth knowing before using this as a prioritisation input.

- **"Explicitly not doing: class scheduling / booking" is no longer true.** It
  shipped: migrations `0015_class_scheduling` and `0016_checkin`,
  `lib/classes.ts`, `lib/checkin.ts`, and the `/dashboard/classes` and
  `/dashboard/checkin` routes. The argument below for *not* building it (off-wedge,
  competing where incumbents are entrenched) was never rebutted anywhere — the
  feature simply arrived. That is worth a decision either way rather than leaving
  the doc contradicting the product.
- **Several "apply now" items have landed.** #1 roster engagement signal
  (`memberEngagementLevel` + the roster badge), #2 live dashboard tiles
  (`app/dashboard/page.tsx` KPI row). Item #1's follow-through — turning the badge
  into something actionable — shipped on 2026-08-04 as the at-risk *brief* and the
  `/dashboard/suggestions` review queue (`lib/briefs.ts`, migration 0021).
- **Still open:** #3 per-exercise set logging + PRs (`ga-engagement-002`) — which
  is also the prerequisite for progression suggestions in `AI-IDEAS.md` — #4
  member-detail activity timeline, #5 trainer follow-up tasks, and #6 lifecycle
  nudges. Note that #6 no longer needs new infrastructure: the task queue
  (migration 0020) is the scheduling substrate it was missing, and the at-risk
  signal that should trigger it already exists.
> **What this is:** A grounded scan of what the best gym/fitness CRMs and a few leading SaaS CRMs do well, evaluated specifically against *our* wedge — **member-facing training programs** delivered on a mobile-first web portal, on a Next.js + Postgres-RLS, EU/GDPR stack. Every idea is tagged with effort/impact and tied to our existing architecture. Sources are real and linked at the bottom; nothing here is invented from memory.

**Our reality check (so recommendations stay honest):** We are a 1–2 dev team. Our differentiator is trainer-authored programs that members actually open and *log*. We already have: staff dashboard (roster with search/filter/pagination, member detail + status history, invite lifecycle, exercise library, program templates, program builder, assignment lifecycle), member portal (view program, history, **log workout**, workout history), GDPR export/erasure, email invites with webhook tracking, observability, a11y/web-vitals budgets. We do **not** have billing, scheduling/booking, or native apps — and several of those are deliberate.

Known internal gaps already flagged in `docs/REVIEW.md` (worth knowing because the cheapest wins below close them): no roster-level engagement signal, per-exercise set logging not yet done, dashboard overview lacks live counts.

---

## Competitive scan

| Product | Standout feature | Relevance to us |
|---|---|---|
| **ABC Trainerize** | Coach-authored programs + client logging, **PRs, progress photos, body stats, habit streaks & badges**, in-app 1:1/group messaging, auto check-in messages, wearable sync (Apple Health/Garmin/Fitbit) | **High — same wedge.** This is the closest competitor to our core. Their engagement layer (streaks, PRs, auto check-ins) is exactly what makes logged programs *sticky*. Strong source of feature ideas; we should cherry-pick the cheap, high-retention parts. |
| **ABC Glofox** | **"Members at Risk" report (16+ data points)** feeding automated re-engagement workflows via ABC XLerate; sleek member app; class booking; Kisi door integration | **High (the churn report), Low (booking/door).** Their at-risk scoring is the model for our roster engagement signal. Booking/door access is off-wedge for us. |
| **PushPress (Core + Grow)** | **Grow CRM**: lead pipeline, automated workflows (At-Risk, 100-day New Member), SMS/email/WhatsApp nurture, review generation; cites measurable lead lift | **Medium.** The *member-lifecycle automation* (New Member onboarding sequence, At-Risk re-engagement) maps well; the lead-gen/marketing-site machinery is beyond our wedge and team size. |
| **Mindbody** | Broad: scheduling, payments, marketing automation, branded apps, role-based staff permissions | **Low–Medium.** Mostly table-stakes scheduling/billing we've deliberately deferred. The dated-CRM-UX critique is instructive: we win by being *focused and modern*, not broad. |
| **Zen Planner / Mat Track / PredictStay / FitnessKPI** | Dedicated **churn-prediction / retention** tooling: short tenure + low attendance + low engagement → 30-day intervention window | **High (concept).** Validates that a simple engagement/at-risk score is genuinely valued. We don't need ML — a rules-based score over our logging data delivers 80% of the value. |
| **HubSpot CRM** | **Activity timeline** per contact, **Tasks with reminders/priority**, "Due Today / Upcoming / Overdue" feed, role/team dashboards | **High (patterns).** The member-detail "timeline" and trainer **follow-up tasks** are proven, cheap, and fit our server-component model directly. |
| **Linear / Intercom (product UX)** | Fast keyboard-driven navigation, command palette, opinionated empty states, inline saved views | **Medium.** UX polish ideas — command palette / saved roster views — that differentiate us against "dated" incumbents without scope creep. |

---

## Prioritized roadmap

Tags: **Impact** (member retention / trainer daily value) × **Effort** (for our 1–2 dev team on the current stack).

### Apply now — cheap, high impact

1. **Roster-level engagement signal (at-risk indicator).** **Impact: High · Effort: Low.**
   Add a "last logged workout / N-day adherence" column + at-risk badge to the roster (`app/dashboard/members/page.tsx`). This is a rules-based version of Glofox's "Members at Risk" and the churn-tooling concept — no ML needed. We already compute `MEMBER_ADHERENCE_SQL`/`RECENT_WORKOUTS_SQL` per-member; lift it into the roster query so a trainer spots who went quiet *without drilling into each profile*. Directly closes `ga-trainer-insights-002`. Pure server-component + RLS-scoped SQL.

2. **Live, navigable dashboard overview.** **Impact: Med · Effort: Low.**
   Make the stub cards (`app/dashboard/page.tsx`) show real RLS-scoped counts (active members, programs assigned this week, workouts logged in last 7 days, at-risk count) — the KPI-tile pattern every incumbent leads with. Closes `review-hardening-dashboard-001`.

3. **Per-exercise set logging (actual sets/reps/weight) + simple PRs.** **Impact: High · Effort: Med-Low.**
   Extend `WorkoutLogInput` beyond session-level effort/note to per-exercise actuals (closes `ga-engagement-002`). This is the heart of Trainerize's value: members logging real numbers, and the resulting **personal-record** highlight ("new best on Squat") is the single highest-retention, lowest-cost motivator. Server Action + new child table, RLS via existing `(id, tenant_id)` FK pattern.

4. ~~**Member-detail activity timeline.**~~ **Done (2026-07-24).**
   The member detail page now shows one HubSpot-style chronological `Timeline`
   (`app/dashboard/members/Timeline.tsx`) merging status changes, program
   assignments, invite sent/accepted events, and logged workouts — replacing the
   narrower `StatusHistory` section it superseded. The merge/sort is a pure
   function (`lib/timeline.ts`, `buildMemberTimeline`), unit-tested in isolation;
   no schema or RLS change (it's a new read-only view over already-RLS-scoped
   data staff could already read).

5. **Trainer follow-up tasks / reminders on a member.** **Impact: Med · Effort: Low-Med.**
   Borrow HubSpot's lightweight Tasks: a trainer can leave a "check in with X by Friday" note on a member, with a "Due today / Overdue" view. Closes the loop after the at-risk signal flags someone. New `task` table (tenant + member scoped, RLS), Server Actions.

### Next — medium effort, strong fit

6. **Automated member-lifecycle nudges (email first).** **Impact: High · Effort: Med.**
   PushPress's "New Member" and "At-Risk" workflows, scoped to our wedge and built on **infrastructure we already have** (Resend + webhook tracking): (a) welcome/onboarding sequence after invite acceptance, (b) "we miss you" email when adherence drops below threshold, (c) "new program assigned" notification. Trigger from the same engagement signal in #1. Start email-only; it's GDPR-cleaner and needs no new vendor.

7. **Member portal engagement layer: streaks & badges.** **Impact: High · Effort: Med.**
   Trainerize/Glofox lean hard on habit streaks and milestone badges because they measurably reduce early drop-off. Built on our logging data, this is computed server-side and rendered in the mobile portal — no native app required. Cheap psychology, high stickiness.
   **Partially done (2026-07-27):** the current-streak half is shipped — `workoutStreakDays`
   (`lib/workout-logs.ts`) counts a member's consecutive logged days (pure calendar-day
   bucketing, unit-tested) and a `StreakBadge` (`app/portal/StreakBadge.tsx`) shows it in
   the portal. No schema or RLS change — it's a read-only aggregate over `workout_log`
   under the existing `workout_log_member_select` policy. **Streak-milestone badges shipped
   (2026-08-14):** `streakMilestoneReached`/`nextStreakMilestone` (`lib/workout-logs.ts`)
   are pure lookups over a fixed milestone list (3/7/14/30/60/100/180/365 days);
   `StreakBadge` switches to a celebratory style on a milestone day and otherwise hints how
   many days remain to the next one. PR-style callouts remain open — they need per-exercise
   weight data that doesn't exist yet (see `docs/RISKY-DEFERRED.md` item B).

8. **Saved roster views + faster trainer navigation.** **Impact: Med · Effort: Med.**
   Our roster state already lives in the URL (shareable/back-button friendly) — extend to named saved views ("At-risk", "New this month") and consider a command-palette jump-to-member (Linear-style) to feel modern next to "dated" incumbents.

9. **Reusable templates → scheduled/progressive programs.** **Impact: Med · Effort: Med-High.**
   We have program templates; the next maturity step (Trainerize-style) is week-over-week progression / scheduling so a program isn't purely point-in-time. Real trainer value, but bigger data-model work — stage after logging depth (#3) lands.

### Later — big bets

10. **PWA + web push for workout reminders.** **Impact: High · Effort: High.**
    We deliberately avoid native apps. A **PWA with web push** is the legitimate middle path: since iOS 16.4, web push works *if the user adds the site to their home screen*, and Android has supported it since 2015. Needs a service worker, manifest, and FCM/APNs plumbing, plus email fallback (graceful degradation). High retention upside (daily touchpoints) but real complexity and an iOS install caveat — hence "later", and a strong candidate for a focused spike before committing.

11. **In-portal trainer↔member messaging.** **Impact: Med-High · Effort: High.**
    Trainerize's 1:1 messaging is a top retention driver, but it's a real feature (realtime, moderation, notifications, GDPR retention rules). Big surface; revisit once nudges (#6) prove demand for two-way contact.

12. **Wearable / Apple Health sync.** **Impact: Med · Effort: High.**
    Trainerize's wearable sync is loved, but it's heavy integration work and largely needs a native shell to be smooth. Park until native is justified by paying gyms.

### Explicitly not doing (and why)

- ~~**Class scheduling / booking & door-access integrations (Mindbody/Glofox/Kisi).** Off-wedge. We're a *program-delivery* CRM, not a front-desk/booking system. Adding it dilutes focus and competes head-on where incumbents are entrenched.~~ **Reversed in practice, not in argument** — scheduling, booking, waitlists and QR/PIN check-in shipped (0015/0016). Door access remains out. See the status note at the top.
- **Full marketing-site builder + lead-gen pipeline (PushPress Grow).** Our entry is invite-only B2B onboarding, not consumer lead capture. The marketing machinery is a different product and a team-size mismatch.
- **SMS/WhatsApp as the *primary* channel (now).** Adds a vendor, per-message cost, and extra GDPR consent surface. Email (already wired via Resend) covers the lifecycle nudges first; reconsider SMS only if open rates prove inadequate.
- **ML-based churn prediction.** The incumbents' "AI" framing is mostly a rules engine over attendance/engagement. Our rules-based at-risk score (#1) captures the value without the modeling, data-volume, and explainability burden. **Still the right call, and now implemented that way**: `lib/briefs.ts` decides who is at risk with rules and narrates it with a template, so the output is deterministic and auditable — which it has to be, since it is read as the basis for contacting a member about their training. See [`AI-IDEAS.md`](AI-IDEAS.md) for where a model could legitimately fit and why it is gated off by default.
- **Billing / payments (now).** Deliberately deferred per project scope; access stays decoupled from payment. Revisit when paying-gym scale demands it.

---

## Why these fit our architecture

- **Server Components + RLS-scoped SQL** make the analytics-flavored wins (engagement signal, dashboard counts, timeline) cheap and *safe by construction* — they're just additional identity-scoped reads, no new isolation surface.
- **The mobile-first portal** can carry streaks/badges/PRs as server-rendered UI today; PWA/push is the only piece that needs new client plumbing.
- **Resend + existing webhook tracking** means lifecycle email automation is incremental, not a new integration.
- **EU/GDPR posture** is a reason to start nudges email-only and to treat messaging/SMS/wearables as later bets with explicit consent + retention design.

**Top 3 to greenlight this week:** (1) roster at-risk signal, (2) per-exercise logging + PRs, (3) live dashboard tiles. All low/med effort, all reuse existing RLS-scoped queries, and together they make trainers' daily loop visibly better and members' logging visibly rewarding.

---

## Sources

- [Best Gym CRM Software in 2026: The Top 6 Compared — PushPress](https://www.pushpress.com/blog/best-gym-crm-software)
- [Gym Management Software in 2026: Mindbody vs. Glofox vs. PushPress — Swipe Savvy](https://swipesavvy.com/resources/blog/savvy-life-gym-fitness-management/)
- [7 Best Mindbody Alternatives for Gym Owners in 2026 — PushPress](https://www.pushpress.com/blog/7-best-mindbody-alternatives-for-gym-owners-in-2026)
- [ABC Trainerize — Features](https://www.trainerize.com/features/)
- [ABC Trainerize Review — Coaching App Cost & Features (PT Pioneer)](https://www.ptpioneer.com/personal-training/tools/trainerize-review/)
- [3 Ways to Improve Client Retention with Customized Automated Messaging — Trainerize](https://www.trainerize.com/blog/3-ways-improve-client-retention-customize-automated-messaging/)
- [Take Your Studio Further With the New ABC Glofox × ABC Trainerize Integration](https://www.trainerize.com/blog/take-your-studio-further-with-the-new-glofox-x-trainerize-integration/)
- [How to Build a Fitness Community That Scales Engagement — Glofox](https://www.glofox.com/blog/why-fitness-communities-drive-retention-at-scale/)
- [Churn Prediction for Gyms: How AI Spots At-Risk Members — Glofox](https://www.glofox.com/blog/ai-churn-prediction/)
- [How Glofox's AI Can Mitigate Member Churn and Boost Retention — Glofox](https://www.glofox.com/blog/how-glofoxs-ai-can-mitigate-member-churn-and-boost-retention/)
- [How to Use Gym Member Retention Software to Prevent Churn — Zen Planner](https://zenplanner.com/blogs/how-to-use-gym-member-retention-software-to-prevent-churn/)
- [Gym Retention Software — Predict & Prevent Member Churn — Mat Track](https://www.mattrack.io/predict-churn/)
- [PredictStay — AI-Powered Gym Member Retention Platform](https://www.predictstay.com/)
- [Grow by PushPress](https://www.pushpress.com/products/grow)
- [PushPress Grow — High-Impact Features](https://www.pushpress.com/blog/pushpress-grow-high-impact-features-tools)
- [Adding Automations to Streamline Growth — PushPress](https://www.pushpress.com/start-a-gym/adding-automations-to-streamline-growth)
- [HubSpot — Create tasks](https://knowledge.hubspot.com/tasks/create-tasks)
- [HubSpot — Set up task reminders and daily task digest](https://knowledge.hubspot.com/tasks/task-reminders-and-daily-digest)
- [HubSpot — Filter activity index pages and record timelines](https://knowledge.hubspot.com/records/filter-activities-on-a-record-timeline)
- [PWA Push Notifications on iOS in 2026: What Really Works — Webscraft](https://webscraft.org/blog/pwa-pushspovischennya-na-ios-u-2026-scho-realno-pratsyuye?lang=en)
- [How to Set Up Push Notifications for Your PWA (iOS and Android) — MobiLoud](https://www.mobiloud.com/blog/pwa-push-notifications)
- [Re-engageable Notifications & Push APIs — MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Tutorials/js13kGames/Re-engageable_Notifications_Push)
