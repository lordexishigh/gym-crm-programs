# Product blueprint — gym/fitness CRM

_The complete definition of this product, researched before the build (live web research)._

## Vision

Alpha CRM is a multi-tenant, web-based gym management platform for independent and boutique fitness businesses in Cyprus where every gym's data is isolated by row-level security enforced at the database layer from a signed JWT — no application bug can expose one gym's data to another. The product's defining capability is the trainer-to-member program loop: a trainer builds a structured workout program from a drag-reorder exercise library, assigns it to a member, and that member opens their phone browser to see their program, log each set with actual weight and reps, and accumulate a session history the trainer can review — a capability no incumbent in the Cyprus market delivers natively. Around that wedge sits a complete gym management foundation: invite-based member onboarding that supports walk-ins with no email address, Stripe recurring billing with SCA/3DS2 compliance, QR code check-in in under three seconds, staff role enforcement at the database layer, and GDPR compliance including per-tenant data export and erasure with a registered data processing agreement for every gym. The member experience is a responsive web portal that passes a Lighthouse audit on a Moto G4 at Fast 3G

## Positioning

Alpha CRM targets the gap left by every incumbent in the Cyprus fitness market: none of them deliver trainer-built workout programs to a member's phone browser as a first-class, native, included feature. Mindbody wins on consumer discovery marketplace and class volume for large studio chains; Alpha CRM does not compete on marketplace reach and wins instead on price predictability — flat per-location rather than per-member — and a member portal that passes a Lighthouse mobile audit rather than crashing on older Android devices. Glofox is the closest structural competitor — European-native, boutique-focused, GDPR-aware — and wins on white-label app brand for gyms that want their own app name; Alpha CRM's edge over Glofox is native training programs with member workout logging (Glofox has non

## Who it is for

- Gym Owner
- Trainer (Staff)
- Front Desk Staff
- Active Gym Member
- New Member (invited, first login)
- Returning Member (session lapsed, 30+ day gap)
- Alpha CRM Platform Admin (super-admin)

## Journeys that must work

- **Gym Owner — Onboard gym in under 15 minutes: provision tenant, import members, create first membership plan**
  1. Receives onboarding invite email from Alpha CRM; clicks 'Set up your gym' link
  2. Fills in gym name, address, phone, timezone (Cyprus default), and owner email; sets password; accepts terms
  3. Wizard step 1 — Membership Plans: clicks 'Add Plan', enters name ('Monthly Standard'), price (€50/month), billing cycle (monthly); saves plan
  4. Wizard step 2 — Payments: clicks 'Connect Stripe'; completes Stripe OAuth redirect; returns to wizard with green 'Connected' indicator
  5. Wizard step 3 — Import Members: downloads CSV template; uploads filled CSV of existing members
  6. System validates CSV and shows preview table: green rows ready to import, red rows flagged with specific error (e.g. 'Row 14: email missing'); owner downloads error rows, fixes in Excel, re-uploads
  7. Confirms import; system creates member records in 'No login' state
  8. Wizard step 4 — Invite Members: selects all imported members; clicks 'Send welcome invites'; bulk invite emails dispatched
  9. Wizard complete screen shown; clicks 'Go to dashboard'
  10. Dashboard displays: active member count, €0 MRR (no payments collected yet), invite-pending count
  - Done when: Tenant provisioned with RLS isolation; at least one plan exists; member records visible in staff dashboard; invite emails in outbox; total elapsed time under 15 minutes from link click to dashboard
- **Gym Owner — Navigate an empty account on first arrival with no data yet**
  1. Completes registration; lands on dashboard for the first time
  2. Sees empty-state screen with three action cards: 'Create your first plan', 'Import your members', 'Invite a trainer' — no blank tables or error states
  3. Clicks 'Create your first plan'; plan creation form opens inline
  4. Saves plan; returns to dashboard; 'Create your first plan' card is now checked; remaining two cards still highlighted
  - Done when: Owner is guided to the next required action at every step; no screen is blank or shows a zero-row table without an explicit call to action
- **Gym Owner — Add a trainer to the gym**
  1. Navigates to Settings > Staff
  2. Clicks 'Invite Staff Member'
  3. Enters trainer's name and email; selects role 'Trainer' from dropdown
  4. Clicks 'Send Invite'; confirmation toast shown
  5. Trainer receives email, clicks link, sets password, lands on trainer dashboard
  6. Owner refreshes staff list; trainer shown with role 'Trainer' and status 'Active'
  - Done when: Trainer can log in and sees only their assigned members and classes; trainer has no access to billing, reports, or other staff records; owner did not contact support
- **Gym Owner — Revoke access for a trainer who left the gym**
  1. Navigates to Settings > Staff
  2. Finds trainer by name; clicks 'Deactivate'
  3. Confirmation dialog warns: 'This trainer's members will remain assigned to them. Reassign before deactivating?'
  4. Owner optionally reassigns members to another trainer using bulk-reassign dropdown
  5. Confirms deactivation
  6. System invalidates all active sessions for that trainer immediately
  - Done when: Deactivated trainer cannot authenticate within seconds of confirmation; member records intact and reassigned; no orphaned assignments
- **Gym Owner — Act on a failed member payment**
  1. Receives email notification within 5 minutes of Stripe webhook: 'Payment failed — [Member Name], €50, Insufficient funds'
  2. Clicks link in email; lands on failed-payment queue filtered to this member
  3. Sees: member name, plan, amount, failure reason, date, number of previous retries
  4. Clicks 'Retry now'; Stripe retries charge immediately
  5. If retry succeeds: member status updates to 'Active'; entry removed from failed-payment queue
  6. If retry fails: member flagged 'Payment overdue'; owner can click 'Email member' to send pre-filled card-update request
  - Done when: Failed payment visible in dashboard within minutes of Stripe event; one-click retry available; member status reflects outcome automatically without manual refresh
- **Gym Owner — View revenue and attendance reports**
  1. Navigates to Reports
  2. Selects date range using date picker (e.g. current calendar month)
  3. Sees report cards: active member count, MRR, payments collected this period, failed payments outstanding, new members, churned members, attendance per class
  4. Clicks a class name in the attendance table to drill down to per-class check-in list
  5. Filters entire report by membership plan tier using dropdown
  6. Clicks 'Export CSV'; downloads file containing all displayed rows
  - Done when: All monetary figures reconcile with Stripe dashboard for the same period; CSV export contains the same rows visible on screen; no report requires contacting support to run
- **Gym Owner — Cancel a member's membership**
  1. Navigates to Members; searches by name
  2. Opens member profile
  3. Clicks 'Cancel Membership'; dialog shows two options: 'Cancel immediately' or 'Cancel at end of current billing period'
  4. Selects option and confirms
  5. Stripe subscription cancelled per selected timing; member status set to 'Inactive' at effective date
  6. Member loses portal login access at effective date; record and history preserved in system
  - Done when: Member is not charged after cancellation; member cannot log in after effective date; full history (check-ins, workouts, payments) remains visible to owner
- **Gym Owner — Fulfil a member's GDPR data erasure request**
  1. Navigates to member profile
  2. Clicks 'Delete Member Data (GDPR)'
  3. System displays what will be erased (PII, auth account, workout logs) vs. what must be retained (anonymised billing records for legal/accounting minimum retention)
  4. Owner confirms; system anonymises PII fields, deletes auth account, anonymises workout session records
  5. Audit log entry created with: requesting admin user ID, timestamp, member pseudonymised ID, action taken
  - Done when: Member cannot log in; name, email, phone, and photo not retrievable from any screen; retained billing records show only anonymised member ID; audit entry exists

## Must have — the product is pointless without these

- **Front Desk Staff role definition and permissions** _(auth)_ — Front Desk Staff is a named persona with a distinct workflow (check-ins, not program building) but StaffProfile.role only enumerates owner|trainer — Front Desk has no role, no RBAC rules, and no described capabilities anywhere.
  - Evidence it's done: A Front Desk account can initiate check-in and look up a member's attendance history but cannot open the program builder, view payment records, or access staff management.
- **Invite token resend with old token invalidation** _(auth)_ — Members who miss the invite email exist in the system in a permanently pending state without a resend path; trainers will work around this with manual WhatsApp messages, bypassing the platform entirely.
  - Evidence it's done: Staff clicks Resend Invite on a pending member; the previously issued token returns HTTP 404 on click; a new token is emailed; the member profile shows Invite sent with the new timestamp.
- **Member authentication — email and password login** _(auth)_ — Members must log in to see their training program; without this the hero differentiator is inaccessible.
  - Evidence it's done: /member/login issues a member-scoped JWT; successful login loads /member/portal; a member JWT submitted to any /api/staff route returns 403; member cannot access another member's data.
- **Signed JWT with tenant_id and role claims stamped onto DB session** _(auth)_ — Identity must flow from a tamper-proof token into the database layer, never from a browser-supplied parameter.
  - Evidence it's done: Decoded JWT contains tenant_id, user_id, and role; middleware stamps these onto the DB session before any query runs; a crafted JWT with a foreign tenant_id fails the RLS check and returns 403; the claim stamp and the query are inside the same transaction.
- **Staff authentication — email and password login** _(auth)_ — Owners and trainers must authenticate to manage their gym; there is no product without this.
  - Evidence it's done: /login issues a signed JWT on success; failed credentials return 401 with no enumeration of whether email exists; valid session loads /staff/dashboard; token expiry is enforced server-side.
- **Per-location flat pricing with no per-member overage** _(billing)_ — Per-member pricing turns a gym's growth into a software price increase; flat pricing converts word-of-mouth from gyms that double their membership.
  - Evidence it's done: The pricing page states a fixed monthly fee per gym location; adding 50 new members via CSV import does not change the invoice amount displayed in the app settings; the pricing page is reachable without logging in.
- **CheckIn data entity** _(checkin)_ — The check-in flow feature and the attendance-reports owner journey both require a table to store check-in events; no CheckIn entity appears anywhere in the data model.
  - Evidence it's done: After a QR scan a row exists in check_ins with member_id, tenant_id, location_id (nullable), method (qr|pin|manual), checked_in_at, and staff_id; the attendance report queries this table.
- **Tenant-scoped Row Level Security on every table** _(infrastructure)_ — Without database-layer isolation, any query bug exposes one gym's data to another — the multi-tenant model collapses entirely.
  - Evidence it's done: SET LOCAL app.current_tenant = :id inside every transaction; RLS policy on every table reads current_setting('app.current_tenant'); a cross-tenant query in an integration test returns 0 rows regardless of the SQL filter.
- **Member mobile program view with inline workout logging** _(member portal)_ — Without in-portal logging the program feature is a PDF replacement; logging is what converts members from passive readers to daily-active users and gives trainers a reason to keep using the builder.
  - Evidence it's done: A member on a 360×800 Android Chrome viewport can view their assigned program, tap Log Set on any exercise, edit weight and reps in an inline form pre-filled with prescribed values, and save — all without horizontal scroll or a tap target smaller than 44×44 CSS px.
- **Member portal — assigned program view, mobile-first** _(member_portal)_ — If the member cannot see their program on a phone browser, the differentiator delivers no value.
  - Evidence it's done: /member/portal renders on a 375 px-wide viewport with no horizontal scroll; each exercise shows name, sets × reps, rest, and notes; base font is 16 px; page load on throttled 4G completes in under 2 seconds; tested on Chrome Android and Safari iOS.
- **Member list with search and pagination** _(members)_ — A gym with 100+ members cannot function if staff cannot locate a specific member quickly.
  - Evidence it's done: /staff/members renders a paginated table defaulting to 25 rows; search box filters by name or email with debounce ≤300 ms; results are strictly scoped to the logged-in gym's tenant_id; URL reflects current page and search term.
- **Member profile — view and edit all fields** _(members)_ — Staff must be able to see and update a member's contact info, photo, membership status, and emergency contact.
  - Evidence it's done: /staff/members/:id shows name, email, phone, profile photo, membership status, join date, emergency contact name and phone; all fields are editable via form; save triggers PATCH /api/members/:id and reflects on reload.
- **Gym tenant provisioning** _(onboarding)_ — Without a way to create a new gym tenant, not a single customer can onboard.
  - Evidence it's done: POST /api/tenants creates a tenant row, seeds an owner user, and returns credentials; the new owner can log in immediately; no data from any other tenant is queryable in the new tenant's DB session.
- **Invite-based member onboarding via signed email token** _(onboarding)_ — Members are not self-serve in v1; the only entry path is a staff-generated invite to prevent unauthorized signups.
  - Evidence it's done: Staff enters a member's email on /staff/members/invite; system sends an email containing a unique signed link; token expires in 72 hours; token is single-use and marked consumed on first click; member sets a password on first visit; expired or consumed token shows an error with a visible 'Request a
- **SPF, DKIM, and DMARC records on the transactional sending domain** _(ops)_ — Invite emails are the onboarding entry point for every member; if they land in spam the member never joins and the trainer-program differentiator delivers zero value to that gym.
  - Evidence it's done: mail-tester.com score >= 9/10 for a test invite email sent from the production sending domain; DMARC DNS record is published with policy p=quarantine or stricter.
- **Member PII erasure workflow** _(privacy)_ — GDPR Art. 17 right to erasure; without a self-service path compliance requires a support ticket per erasure request, which is not scalable and makes the gym owner directly liable for delays.
  - Evidence it's done: Member submits erasure request in their portal; gym owner sees a pending deletion_request in dashboard; after confirmation the member record shows tombstone-only; member receives confirmation email; the member no longer appears in any staff-facing list.
- **Per-tenant GDPR data export** _(privacy)_ — GDPR Art. 20 data portability right and the practical requirement that a gym can migrate away without data loss; blocking export is a regulatory violation and an accelerant to support escalation.
  - Evidence it's done: Gym owner navigates to Settings > Data > Export; within 72 hours receives an emailed link to a ZIP containing members.csv, programs.json, check_ins.csv, and billing_history.csv with all records for their tenant only.
- **Assign a program to a specific member** _(programs)_ — A program that cannot be assigned to a member is just a document; trainer-to-member delivery is the wedge.
  - Evidence it's done: On /staff/programs/:id, 'Assign to member' opens a member picker; selecting a member creates a ProgramAssignment row; the member sees the program in their portal within 30 seconds without a full page reload.
- **Program builder — create a program with exercises** _(programs)_ — This is the primary differentiating feature; without it Alpha CRM is indistinct from incumbents.
  - Evidence it's done: Trainer navigates to /staff/programs/new; adds exercises by name; sets sets, reps, rest in seconds, and a notes field per exercise; saves to create a named program scoped to that gym's tenant_id; entire flow completable in under 8 minutes on first use.
- **Program-assigned notification to member** _(programs)_ — A member has no mechanism to discover they have been given a new program; without a trigger the member portal is a dead-end after first login — the differentiator never activates.
  - Evidence it's done: Assigning a program triggers a transactional email to the member containing their name, the program name, and a direct link to /portal/programs; the email fires within 60 seconds of assignment.
- **Trainer program builder with exercise library and drag-reorder** _(programs)_ — The entire competitive wedge collapses if building a 5-exercise program takes more than 4 minutes on first use; trainers revert to PDF within two weeks.
  - Evidence it's done: A trainer creates a 5-exercise program with sets, reps, rest, and a per-exercise note, reorders two exercises by drag-and-drop, and assigns it to a member without a full page reload in under 4 minutes measured by a first-time user.
- **WorkoutLog and SetLog data entities** _(programs)_ — Inline workout logging is the stated competitive differentiator; there is no WorkoutLog, SetLog, or equivalent table in the data model — logged sets have nowhere to persist.
  - Evidence it's done: A member taps 'log set', enters weight and reps, and the row persists to a set_logs table linked to program_assignment_id, exercise_id, a session date, and the member's user_id; re-opening the app the next day shows prior entries.
- **Revenue and attendance reports** _(reporting)_ — An explicit Gym Owner journey reads 'View revenue and attendance reports' but no reporting feature, screen, chart, or data query is described anywhere in the blueprint.
  - Evidence it's done: A Reports screen shows: active member count, MRR, check-ins per day and week for the last 30 days, and top programs by assignment count; all panels are exportable as CSV.
- **RLS claim scoped per-transaction, not per-session** _(security)_ — A connection pooler in transaction mode carries one tenant's JWT claim into another tenant's query under concurrent load — the isolation guarantee fails in production but is invisible in development.
  - Evidence it's done: An integration test fires 200 concurrent requests from two distinct tenant users through one shared connection pool and asserts zero cross-tenant rows appear in any response; the test is part of CI and blocks deploy on failure.
- **Custom 404, 500, and maintenance error pages** _(ux)_ — Default Next.js error pages expose the framework version, have no gym context, and provide no recovery path — a gym owner or member seeing a blank 500 will call support or churn.
  - Evidence it's done: Navigating to /nonexistent-route shows a branded page with a Back to Dashboard link, not the Next.js default. A maintenance flag in the ops console shows a full maintenance page with estimated restore time instead of a 503.

## Expected — users assume every serious product has these

- **Email change flow for staff and members** _(auth)_ — Users change email addresses; without this they are permanently bound to their invite address, and the only escape is deletion and re-invite — an implicit but unacceptable constraint.
  - Evidence it's done: Submitting a new email in Account Settings sends a confirmation link to the new address; the change applies only after the link is clicked; a security notice is sent to the old address.
- **Ownership transfer** _(auth)_ — Gym businesses change hands; without transfer, the new owner has no path to take over without platform admin intervention, and the old owner's account must be manually downgraded.
  - Evidence it's done: Owner Settings has 'Transfer ownership'; selecting an existing staff member as the new owner sends a confirmation email to the recipient; on acceptance the old owner's role is changed to trainer.
- **Password reset flow distinct from the invite flow** _(auth)_ — Forgotten passwords are the highest-volume auth support request; without self-service reset, staff email the gym owner who emails support — losing multiple staff-hours per incident.
  - Evidence it's done: Login page has a Forgot password link; submitting an email sends a time-limited (1-hour) single-use reset link; the link renders a set-new-password form; all other active sessions for that account are invalidated after reset.
- **Password reset via email** _(auth)_ — Any product that emails users for onboarding must also support credential recovery — members will forget passwords.
  - Evidence it's done: /forgot-password sends a reset link to the verified address; link expires in 1 hour; the token is invalidated immediately after the password change; new password is subject to a minimum-strength rule; the old address receives a security notification email.
- **Rate limiting on authentication endpoints** _(auth)_ — Login and password-reset endpoints are brute-force targets; without rate limiting, credentials can be enumerated.
  - Evidence it's done: POST /api/auth/login and POST /api/auth/forgot-password return 429 after 10 requests per IP per minute; the limit is per IP and per email to prevent account lockout via distributed attack; rate-limit headers are present in the response.
- **Role-based access control — owner vs trainer** _(auth)_ — Trainers must not see billing or revenue; owners must not lose administrative control.
  - Evidence it's done: A trainer-role JWT submitted to GET /api/billing, GET /api/reports/revenue, or any /api/staff/settings route returns 403; trainer routes are limited to member management and programs; test suite covers every protected route with both role tokens.
- **Self-serve staff invite by email with role selection** _(auth)_ — Gym owners hire and fire frequently; requiring a support ticket to add a trainer is the single most-cited friction point in staff-managed SaaS.
  - Evidence it's done: An owner-role user navigates to Settings > Staff, enters an email and selects Trainer or Front Desk role, clicks Invite, and the invitee receives a functional invite email within 2 minutes — no action required from the SaaS operator.
- **Session logout and idle timeout** _(auth)_ — Shared gym computers must not leave sessions open indefinitely.
  - Evidence it's done: A 'Sign out' action is reachable from every authenticated page in one click; the server invalidates the session token on logout; idle sessions (no request for 8 hours) are expired server-side; the next request from an expired session redirects to login.
- **Staff role enforcement at the database layer** _(auth)_ — A trainer reading another trainer's member list is a privacy violation; UI-only gating is bypassable by anyone who reads a network tab.
  - Evidence it's done: A Playwright test authenticated as a trainer directly calls /api/members and asserts the response contains only members assigned to that trainer's user ID; the test fails if RLS is disabled regardless of UI state.
- **Drop-in member and single-charge billing** _(billing)_ — MembershipPlan.billing_interval includes drop_in but no feature describes how a drop-in visit is charged, recorded, or reflected in attendance history.
  - Evidence it's done: Staff can record a drop-in for any member; a one-off Stripe PaymentIntent for the configured drop-in price fires immediately; the visit appears in the member's attendance history tagged 'Drop-in'.
- **Failed payment queue with one-click retry** _(billing)_ — Revenue leakage from unretried failed payments is the highest-cost billing gap for gyms; surfacing it visibly is a trust signal.
  - Evidence it's done: /staff/billing/failed-payments lists members with a failed invoice, failure reason code, date, and amount; a Retry button triggers Stripe's invoice.pay immediately; the row updates on webhook receipt; member status badge reflects 'Payment failed' until resolved.
- **Failed payment queue with per-member one-click retry** _(billing)_ — Real-time payment failure visibility is a stated category success factor and the top competitor complaint gap; a queue with immediate retry is the concrete implementation that converts the alerting requirement into recovered revenue.
  - Evidence it's done: Billing > Failed Payments lists each affected member, failure reason (card declined / insufficient funds / expired card), next scheduled retry date, and a Retry now button that fires an immediate Stripe charge attempt and shows the outcome inline.
- **Gym tenant cancellation and offboarding** _(billing)_ — A gym stopping the service needs to cancel, export data, and have its tenant decommissioned; no cancellation journey, data-retention window, or decommission flow is described.
  - Evidence it's done: Settings → Danger Zone has a 'Cancel subscription' action; cancelling schedules decommission at the current period end, triggers a full GDPR export email to the owner, and marks the tenant deleted_at after a 30-day grace period.
- **Member payment method update** _(billing)_ — Member subscription management is listed but a member cannot update their card or bank account; failed payments cannot self-heal without a SetupIntent flow exposed to the member.
  - Evidence it's done: Member portal /billing shows the current payment method masked and a 'Update payment method' button that opens a Stripe Payment Element; on success the new method is set as default on the Stripe Customer object.
- **Member subscription management — view, switch plan, cancel** _(billing)_ — Gyms regularly move members between plans and cancel departing members.
  - Evidence it's done: Staff on /staff/members/:id sees active plan name, next billing date, and payment history; owner can switch plan with proration via Stripe; owner can cancel at period end; a confirmation modal shows the final charge date before committing cancellation.

## The professional bar

- **security** — Every SQL query touching tenant data must execute inside a transaction that sets app.current_tenant_id via SET LOCAL before any RLS-bearing statement; the claim must not be set on the connection outside a transaction boundary.
- **security** — The JWT's tenant_id and user_id claims are the sole authoritative source of identity for every API route; no request body, URL parameter, or HTTP header may supply or override the tenant_id that RLS policies read.
- **security** — Invite tokens are single-use, hashed with SHA-256 before DB storage, and expire after 48 hours; the plain token is emailed once and never persisted; a used or expired token returns HTTP 404, not 403, to prevent oracle attacks.
- **security** — All mutating HTTP endpoints (POST, PUT, PATCH, DELETE) require a SameSite=Strict session cookie; cross-origin state-changing requests receive a 403; no state is mutated via GET.
- **security** — Auth endpoints (login, password reset, invite accept) are rate-limited to 5 requests per IP per minute; after 10 consecutive failed login attempts on one account that account is locked for 15 minutes and an alert is emailed to the gym owner.
- **security** — All HTTP responses include: Strict-Transport-Security (max-age=31536000; includeSubDomains), Content-Security-Policy blocking unsafe-inline scripts, X-Frame-Options: DENY, X-Content-Type-Options: nosniff, Referrer-Policy: strict-origin-when-cross-origin.
- **security** — Stripe webhook payloads are verified using the Stripe-Signature header and the endpoint's signing secret before any database write; payloads that fail signature verification are rejected with HTTP 400 and logged.
- **security** — Any column that may store health data — injury notes, medical restrictions, body-fat percentage, biometric measurements — is encrypted at the column level with an application-managed key; every read of that column is written to an access_log table with the accessing user_id, tenant_id, and timestamp
- **security** — Staff passwords must be >= 12 characters; hashed with bcrypt at cost factor >= 12; checked against the HaveIBeenPwned Passwords API via k-anonymity prefix at creation and on change; a match triggers a forced reset with a user-visible explanation.
- **performance** — Member portal Largest Contentful Paint < 2.5 s measured by Lighthouse on a Moto G4-class device (2 GB RAM) on simulated Fast 3G (1.6 Mbps / 150 ms RTT) with a cold cache; the program page must be interactive (all set-log inputs tappable) within 3.5 s on the same profile.
- **performance** — Trainer dashboard Time to Interactive < 3 s on desktop Chrome at 20 Mbps / 20 ms RTT; member list with 500 entries paginates at 50 per page and the first page returns in < 200 ms at p99 under 50 concurrent staff sessions.
- **performance** — Check-in confirmation (QR scan or PIN entry to success screen visible on staff device) completes in < 3 s end-to-end including server round trip under 50 concurrent check-in requests — the peak scenario at a busy class start.
- **performance** — Member photos are resized server-side to 400x400 px, converted to WebP, and capped at 200 KB; the original upload is discarded after processing; images are served from a CDN with Cache-Control: public, max-age=31536000, immutable.
- **performance** — All Postgres queries on members, program_assignments, and check_ins tables use composite indexes on (tenant_id, <primary lookup column>); EXPLAIN ANALYZE in CI must show index scans, not sequential scans, on tables seeded with 100 tenants x 1000 members.
- **accessibility** — All text and interactive elements meet WCAG 2.1 AA contrast: 4.5:1 for body text, 3:1 for large text (>= 18 pt or 14 pt bold) and UI component boundaries; verified by axe-core in CI and by manual check with the Colour Contrast Analyser tool against final rendered output, not design mocks.
- **accessibility** — Every form field has an associated <label> via htmlFor; no field uses placeholder text as its only label; all validation errors are linked via aria-describedby and announced by screen readers; focus moves to the first errored field on submit.
- **accessibility** — All touch targets on the member portal — set-log checkboxes, buttons, navigation links — are >= 44x44 CSS pixels with >= 8 px gap between adjacent targets, as required by WCAG 2.5.5.
- **accessibility** — All modal dialogs trap focus: Tab and Shift+Tab cycle only within the open modal; Escape closes it and returns focus to the trigger element. Verified by keyboard-only navigation test against every modal in the product.
- **accessibility** — No decorative animation or transition exceeds 3 flashes per second (WCAG 2.3.1); any animation lasting > 5 s exposes a pause control; the prefers-reduced-motion media query disables all non-essential motion.
- **responsive** — The member portal renders with no horizontal overflow at 320 px viewport width (iPhone SE first-generation CSS resolution); all interactive elements are reachable without zooming. Tested in Chrome DevTools iPhone SE preset and on a physical Android device at 360 px.
- **responsive** — The program log screen (member marking sets done, entering weight and reps) is operable with one thumb in portrait orientation on a 375 px viewport; no required input is obscured by the on-screen keyboard — verified with the iOS and Android virtual keyboards visible during testing.
- **responsive** — The trainer dashboard reflows to a single-column layout at < 768 px with all primary actions (add member, assign program, initiate check-in) accessible without horizontal scroll; data tables reflow to card-stack layout rather than truncating columns or requiring horizontal scroll.
- **responsive** — All pointer-dependent interactions (hover tooltips, hover-reveal action menus) have a touch-equivalent on touch devices; CSS uses the pointer: coarse media query to render larger controls and visible-by-default action menus when the input device is a finger.
- **seo** — Public marketing and landing pages have unique <title> tags (< 60 chars), <meta name='description'> (< 160 chars), and <link rel='canonical'>; all public pages are server-side rendered so crawlers receive full HTML without executing JavaScript.

## Data

- Tenant (gym — id, name, logo_asset_id, timezone, contact_email, address, stripe_customer_id, created_at), User (auth identity — id, email, password_hash, email_verified_at, last_login_at; shared by staff and members), StaffProfile (id, user_id, tenant_id, role: owner|trainer, deactivated_at), Member (id, tenant_id, user_id nullable for walk-ins, name, email, phone, photo_asset_id, membership_status, date_of_bir, InviteToken (id, tenant_id, member_id, token_hash, expires_at, consumed_at, sent_by_staff_id), MembershipPlan (id, tenant_id, name, billing_interval: monthly|annual|drop_in, price_cents, currency, trial_days, stripe, Subscription (id, tenant_id, member_id, plan_id, stripe_subscription_id, status, current_period_start, current_period_en, Payment (id, tenant_id, member_id, subscription_id, stripe_invoice_id, amount_cents, currency, status: paid|failed|pendi, Exercise (id, tenant_id, name, description, default_sets, default_reps, default_rest_seconds, video_url, created_by_staf, Program (id, tenant_id, name, created_by_staff_id, created_at, updated_at), ProgramExercise (id, program_id, exercise_id, sets, reps, rest_seconds, notes, sort_order), ProgramAssignment (id, tenant_id, program_id, member_id, assigned_by_staff_id, assigned_at, status: active|archived)

## Integrations

- Stripe — Subscriptions, Payment Element (card + SEPA Direct Debit), SetupIntents, PaymentIntents with 3DS2/SCA, webhooks
- Transactional email provider (Resend, Postmark, or SendGrid) — invite emails, booking confirmations, waitlist promotions
- Object storage (AWS S3 or Cloudflare R2) — member photos, gym logos, exercise GIFs and videos, CSV export files, GDPR ex
- PostgreSQL with Row Level Security — primary datastore; RLS policies on every table reading current_setting('app.current
- Next.js and Vercel (or equivalent) — SSR for member portal and staff dashboard; Edge Middleware validates JWT and stamps
- Error and performance monitoring (Sentry) — client and server error capture; release tracking; performance traces on dat
- iCalendar feed generator — per-member .ics subscription URL for booked classes; RFC 5545 compliant; compatible with Goog
- SMS provider (Twilio or Vonage) — optional channel for failed-payment alerts and waitlist promotions for members who opt

## Launch checklist

- [ ] Multi-tenant RLS isolation verified under concurrent load: Postgres connection pooler configured in session mode, or every query that reads tenant data wraps the SET LOCAL jwt.claims.tenant_id call and the query inside the same transaction so the claim cannot bleed across pool connections; an integr
- [ ] GDPR processor obligations operational before first paying gym: a written Data Processing Agreement template attached to every subscription at sign-up, a Record of Processing Activities covering member name, contact, health notes, payment history and their legal basis, a published sub-processor list
- [ ] Cyprus data protection registration: verify with the Office of the Commissioner for Personal Data Protection of Cyprus (under Law 125(I)/2018 implementing GDPR) whether the SaaS operator must notify or register before commercially processing member personal data; complete registration if required be
- [ ] Email sending infrastructure: SPF, DKIM, and DMARC records published on the transactional sending domain; a batch of 10 test invites scored below 2.0 on Mail-Tester before launch; Stripe, invite, and system emails routed through a dedicated sending domain separate from any marketing domain; bounce a
- [ ] Member invite flow hardened for real gym conditions: invite token expires after 72 hours with a visible expiry state in the staff dashboard and a one-click Resend button; a member record can be created with no email address at all (walk-in, child, paper signup) and later linked to an auth account wi
- [ ] Stripe SCA/3DS2 compliance for EU recurring billing: off-session charges use Stripe's automatic payment retries with exemption handling; if a card requires a 3DS2 challenge, an action-required email with a Stripe-hosted payment link fires within 5 minutes of the failed charge; Stripe payouts to a Cy
- [ ] Error monitoring with PII-stripped context: Sentry (or equivalent) captures every unhandled server-side exception with tenant_id in the context and member PII removed from breadcrumbs and payloads; an alert fires to an on-call Slack channel or email within 2 minutes of a new unhandled exception type
- [ ] Product analytics capturing the three funnels that determine whether the product works: trainer program creation (program started, exercise added, program saved, program assigned to member); member portal activation (invite sent, invite link clicked, account created, program viewed, first set logged
- [ ] First-run onboarding wizard: a new tenant account with no data can complete the following sequence without leaving the wizard or contacting support: create one membership plan with a name and monthly price, invite one staff member by email, and either import a CSV of members or add one member manual
- [ ] Demo tenant accessible without sign-up: a public /demo route (or equivalent) logs the visitor into a read-only pre-populated gym containing 3 members with photos, 2 assigned programs each with 4 exercises (sets, reps, rest, notes), one logged workout session with actual weights recorded, and one ove
- [ ] Automated daily database backups retained for 30 days in a geographically separate storage bucket from the primary database; point-in-time recovery tested by restoring a 24-hour-old snapshot to a staging environment and verifying member count, program assignments, and workout log row counts match th
- [ ] Zero-downtime deployment pipeline: every pull request deploys to a preview environment with its own isolated database; production deploy requires passing CI including lint, type check, unit tests, and the RLS cross-tenant integration test; every schema migration is backwards-compatible with the prev
- [ ] Legal pages linked from the login screen before any user data is collected: Privacy Policy stating what categories of data are collected, who the controller is (each gym) and who the processor is (the SaaS operator), the lawful basis for each processing purpose under GDPR Art. 6, how members can req
- [ ] Pricing and billing transparency visible within the app: a pricing page states the per-location monthly fee, what member ceiling (if any) applies, and that no per-member overage is charged below that ceiling; the gym owner can view their current subscription, next invoice date, and next invoice amou
- [ ] Support path documented and functional before launch: a support email address with a stated next-business-day response SLA; a searchable FAQ or help centre covering the 10 most common staff workflows (add member, create program, assign program, check in member, view payment history, change membershi
- [ ] Security baseline verified before accepting payment: every API route validates the JWT and extracts tenant_id and user role from the token before executing any database query; no route reads tenant_id or member_id from the request body for access-control purposes; auth endpoints (login, invite accep

## Definition of done

- [ ] A gym staff member submits valid email and password and receives a signed JWT; an invalid credential returns HTTP 401 with the message 'Invalid email or password' with no variation that reveals whether the account exists.
- [ ] A member submits valid email and password and lands on their assigned program view in three navigation steps or fewer, with no intermediate loading screen longer than 2.5 seconds.
- [ ] Staff passwords are rejected at creation if fewer than 12 characters or if the SHA-1 prefix appears in the HaveIBeenPwned Passwords API response; a match returns a user-visible explanation and the field does not accept the password until a compliant value is entered.
- [ ] Auth endpoints (login, password reset, invite accept) return HTTP 429 after 5 requests from the same IP within 60 seconds; an account is locked for 15 minutes after 10 consecutive failed login attempts and the gym owner receives an automated email within 5 minutes of the lock event.
- [ ] Password reset is a distinct flow from invite acceptance: a reset link cannot be used to complete first-time account setup, and an invite link cannot be used to reset a password on an established account.
- [ ] Invite tokens are SHA-256-hashed before insertion into InviteToken; the plain token appears only in the emailed link and is never written to the database, logs, or error payloads; a consumed or expired token returns HTTP 404; a token older than 48 hours is rejected even if unconsumed; a resent invit
- [ ] Every session cookie is set with SameSite=Strict and HttpOnly; a cross-origin POST to any mutating endpoint returns HTTP 403; no state is mutated via GET.
- [ ] Sessions expire after a configurable idle timeout (default 8 hours for staff, 30 days for members); logout invalidates the server-side session; a logged-out session token returns HTTP 401 on any subsequent request.
- [ ] Every query touching a tenant-scoped table executes inside a transaction that issues SET LOCAL app.current_tenant_id before the first RLS-bearing statement; a query that issues SET LOCAL outside a transaction boundary is rejected by a pre-query assertion and the request returns HTTP 500 with a sanit
- [ ] The JWT's tenant_id and user_id claims are the sole authoritative source of identity for every API route; grep across all API route handlers shows zero instances of tenant_id or member_id being read from req.body, req.params, or non-JWT headers for access-control decisions.
- [ ] An automated integration test sends 1,000 interleaved requests from two distinct tenant JWTs through a single pooled connection and asserts that zero rows belonging to tenant A are returned in tenant B's responses, and vice versa; this test runs in CI on every pull request merge.
- [ ] A psql \d+ on every table in the production schema shows at least one RLS policy; pg_class where relrowsecurity is false returns zero rows for tenant-scoped tables.

## Success metrics

- 80% of members who receive an invite email complete account creation and view their assigned program within 7 days of the invite being sent, measured across the first 30 gyms onboarded.
- A trainer with no prior Alpha CRM experience builds and assigns their first program in under 8 minutes when timed during a facilitated usability session with no coaching; target validated across at least 5 distinct trainers before launch.
- Member portal Lighthouse LCP remains below 2.5 s on the Moto G4 / Fast 3G profile on every production deployment; a regression above 2.5 s blocks the deploy.
- Check-in end-to-end latency remains below 3 s at the 95th percentile under 50 concurrent requests in the pre-release load test on every production deployment.
- 100% of Stripe invoice.payment_failed webhook events result in a visible entry in the gym owner's failed-payment queue within 60 minutes of the webhook firing, with zero missed events over a rolling 30-day window.
- The RLS cross-tenant integration test (1,000 interleaved requests from two tenant JWTs through one pool) returns zero cross-tenant rows on every CI run; any failure blocks all further deployments until resolved.
- A new gym tenant completes the onboarding wizard (create plan, invite staff, add or import member) without contacting support in under 15 minutes; measured and confirmed for 90% of the first 30 gyms onboarded.
- 40% or more of members who log their first workout set log at least one additional set in a different session within 90 days, indicating the program loop is delivering recurring value rather than a one-time novelty.

## Why products like this get abandoned (designed out)

- Trainer never uses the program builder after the first week: if the exercise entry flow requires more than 4 clicks per exercise or does not remember previously typed exercise names, trainers abandon it after one frustrating session and return to sending PDF workout sheets via WhatsApp — the gym own
- Member portal activation rate stays below 30% at the gym level: if fewer than one in three invited members ever log in to view their program, trainers stop assigning digital programs because no one reads them — the feature silently dies and the product becomes an expensive member contact list.
- Invite emails are undeliverable or land in spam: gyms in Cyprus frequently use free Gmail accounts or local ISP domains with aggressive spam filters; if the first batch of 10 to 20 member invites is silently dropped or flagged, the gym owner concludes the product is broken and does not investigate S
- The gym owner who evaluated and onboarded the product leaves or promotes a new manager: the replacement inherits an account they did not set up, cannot find how to add a member or pull a report without calling support, and defaults to whatever CRM their previous employer used — the product loses a p
- A single visible billing error in the first three months destroys payment trust: a duplicate charge, a charge to a cancelled member, or a refund that takes more than five business days is attributed immediately to the software by the gym owner; no feature advantage survives a payment incident that a
- Check-in fails during a high-traffic class: a QR code that does not scan in low lobby light, a 4-second server response when 15 members arrive simultaneously, or a page that requires a reload to activate — any of these in front of arriving members causes the front-desk staff to tell the owner the sy
- No audit log means staff disputes cannot be resolved: when a trainer waives a fee, deletes a member record, or changes a membership plan and the owner cannot determine who made the change or when, they lose confidence in the platform as a business system and start evaluating alternatives regardless 
- Members feel locked in and say so publicly: a gym that grows, acquires a second location, or wants to switch accountants discovers that program history, workout logs, and attendance records are not exportable in a usable format — the gym owner voices this on a local business forum and the word-of-mo

## Deliberate non-goals

- Native iOS or Android apps — deferred until paying gyms explicitly justify the overhead; the member experience ships as a responsive web portal only.
- Consumer-facing marketplace for gym discovery or lead generation — Alpha CRM serves gyms that already have members, not a platform for acquiring them.
- Class and group session scheduling with per-class capacity limits, waitlists, and auto-promotion — planned as post-wedge table stakes but not in scope for the initial launch.
- Third-party workout tracking integrations with SugarWOD, Garmin Connect, Apple Health, or Google Fit.
- White-label member portal under a gym's own domain and brand name.
- Belt, rank, or skill-progression tracking for martial arts, Brazilian jiu-jitsu, or similar belt-system gyms.
- Multi-location chains with consolidated billing, cross-location member lookup, or a head-office reporting dashboard — each location is a separate tenant in v1.
- In-app direct messaging between trainer and member.
- Automated retention alerts triggered by configurable no-check-in thresholds.
- Member progress charts or lift-history visualisation over time.
- iCalendar feed generation for booked classes.
- SMS notifications via Twilio or Vonage.

## Risks

- RLS claim bleed under connection pooling: if SET LOCAL app.current_tenant_id is issued outside the same transaction as the query it guards and the pooler reuses the connection in transaction mode, one tenant's identity claim can persist into another tenant's query under concurrent load. This is a lo
- GDPR Art. 9 health-data reclassification: trainers will enter injury notes, medical restrictions, and body metrics into program exercise notes and member profile fields. If those constitute special-category health data under GDPR Art. 9, the lawful basis changes from Art. 6 legitimate interest to Ar
- ThinkCRM ships member programs before Alpha CRM launches: the entire build order — thin foundation first, program feature second, CRM table stakes third — is justified by the premise that ThinkCRM lacks native trainer-to-member program delivery. If ThinkCRM ships or publicly announces this feature b
- Stripe SCA/3DS2 breaks off-session recurring billing for EU cards: EU-issued cards subject to Strong Customer Authentication will decline off-session charges that lack a recognised exemption. A naive Stripe Subscriptions implementation will see materially elevated decline rates from the first billin
- Email deliverability failure silences the invite flow: if SPF, DKIM, or DMARC are misconfigured, the sending IP has poor reputation, or the sending domain is shared with other senders, invite emails land in spam and the member never sees the link. The gym blames the product for members not activatin
- Walk-in members with no email address break implicit auth assumptions: the schema allows nullable user_id on Member but the invite flow, QR check-in, GDPR erasure, and member list views may implicitly assume every member record has a linked auth account. Uncorrected, walk-in and child member records
- Cyprus data protection registration delay: if Cyprus Law 125(I)/2018 requires advance registration or notification to the Office of the Commissioner for Personal Data Protection before commercial processing of personal data begins, a delayed registration inquiry can block the first paying gym. Mitig
- Member count ceiling surprise at renewal: a per-location flat price with a member ceiling is not the same as unlimited-member flat pricing. A gym that grows past the ceiling will see an unexpected tier upgrade on their next invoice. If the ceiling and tier structure are not visible before the gym co
