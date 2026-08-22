import { withTenantContext, type Identity } from "../db";
import type { ExerciseRow } from "../programs";
import {
  MEMBER_STATUS_HISTORY_SQL,
  type MemberStatusEvent,
} from "../member-records";
import { deleteAuthUser } from "../auth/admin";
import { recordGdprEvent, resolveActorUserId } from "./audit";

/**
 * Tombstone values written in place of personal data on erasure (beta-gdpr-002).
 * Anonymisation keeps the row (preserving referential integrity) but removes any
 * data that could identify the subject. These are exported so tests assert the
 * exact post-erasure shape and the values cannot silently drift.
 */
export const ERASED_MEMBER_NAME = "Erased member";
export const ERASED_INVITE_EMAIL = "[erased]";
export const ERASED_TASK_TITLE = "[erased]";
export const ERASED_SUGGESTION_HEADLINE = "[erased]";
export const ERASED_PAYMENT_TEXT = "[erased]";

/**
 * Member data export (beta-gdpr-001).
 *
 * Builds a portable JSON document of a single data subject's (member's) personal
 * data and logs the export to the audit trail — both in ONE tenant-scoped
 * transaction so an export is recorded iff it succeeds. Isolation is enforced by
 * RLS, not by these queries: every read runs as the unprivileged `app_user`, so
 * a staff caller sees only members in their own gym and a member caller sees only
 * their own rows. A crafted/cross-tenant `memberId` therefore resolves to no
 * data — which the `gdpr-export-rls` test asserts directly.
 *
 * Scope by role:
 *   - staff (DSAR fulfilment): the complete record — profile, status history,
 *     invites, all assigned programs with exercises, workout logs, check-in
 *     (attendance) history, and class bookings.
 *   - member (self-service): profile + assigned programs/exercises + workout
 *     logs + check-ins + class bookings (all the member's own data). The
 *     staff-internal tables (status history, invite tokens) are controller
 *     records the member RLS policies do not expose; they are omitted rather
 *     than relied upon to return empty.
 */

/** A subject's exported member profile (all stored personal fields). */
export type ExportedMember = {
  id: string;
  email: string | null;
  full_name: string;
  phone: string | null;
  status: string;
  notes: string | null;
  photo_url: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  created_at: string;
  updated_at: string;
  erased_at: string | null;
};

/** One exported invite (token hashes are never included). */
export type ExportedInvite = {
  id: string;
  email: string;
  status: string;
  expires_at: string | null;
  created_at: string;
  accepted_at: string | null;
};

/** An assigned program with its ordered exercises, as exported. */
export type ExportedProgram = {
  assignment_id: string;
  status: string;
  assigned_at: string;
  program: {
    id: string;
    name: string;
    description: string | null;
  };
  exercises: ExerciseRow[];
};

/** One logged workout session, as exported (Phase GA — ga-engagement-001). */
export type ExportedWorkoutLog = {
  id: string;
  program_id: string;
  program_name: string;
  completed_at: string;
  effort: number | null;
  note: string | null;
};

/** One recorded gym visit, as exported (market gap #5 — check-in). */
export type ExportedCheckIn = {
  id: string;
  method: "pin" | "qr";
  checked_in_at: string;
};

/** One class booking, as exported (market gap #4 — class scheduling). */
export type ExportedClassBooking = {
  booking_id: string;
  class_id: string;
  class_name: string;
  starts_at: string;
  status: string;
  booked_at: string;
  cancelled_at: string | null;
};

/** One staff-authored follow-up task, as exported (CRM-IDEAS "Apply now" #5). */
export type ExportedMemberTask = {
  id: string;
  title: string;
  due_at: string | null;
  completed_at: string | null;
  created_at: string;
};

/**
 * One card payment, as exported. Written by the Stripe webhook
 * (`lib/stripe-events.ts`), never by hand.
 *
 * This was MISSING from the export until 0026's manual-payment work went in: a
 * member's payment history is their personal data under Art. 15, and the export
 * silently omitted all of it. Adding only the manual half would have been worse
 * than either — an export that reads as complete financial history while holding
 * half of it.
 */
export type ExportedPaymentEvent = {
  id: string;
  amount_cents: number;
  currency: string;
  status: string;
  occurred_at: string;
};

/**
 * One off-card payment (cash / bank transfer / SEPA) recorded by staff — 0026.
 * `void_reason` is staff-authored free text about this member, so erasure has to
 * scrub it (see `anonymiseMember`).
 */
export type ExportedManualPayment = {
  id: string;
  amount_cents: number;
  currency: string;
  method: string;
  reference: string | null;
  note: string | null;
  received_on: string;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
};

/** The full export document handed to the data subject. */
export type MemberDataExport = {
  format: "alpha-crm.member-export";
  format_version: 1;
  subject: { type: "member"; id: string };
  member: ExportedMember;
  status_history: MemberStatusEvent[];
  invites: ExportedInvite[];
  programs: ExportedProgram[];
  workout_logs: ExportedWorkoutLog[];
  check_ins: ExportedCheckIn[];
  class_bookings: ExportedClassBooking[];
  tasks: ExportedMemberTask[];
  payment_events: ExportedPaymentEvent[];
  manual_payments: ExportedManualPayment[];
};

/** Result of an export: the document (null if the subject was not found). */
export type ExportResult = { data: MemberDataExport | null };

/**
 * Export `memberId`'s personal data under `identity`, logging the action. Returns
 * `{ data: null }` when the member is not visible to the caller (not found,
 * other member, or cross-tenant) — the route maps that to a 404.
 */
export async function exportMemberData(
  identity: Identity,
  memberId: string,
): Promise<ExportResult> {
  const isStaff = identity.role === "staff";

  return withTenantContext(identity, async (c) => {
    const member = (
      await c.query<ExportedMember>(
        `select id, email, full_name, phone, status, notes,
                photo_url, emergency_contact_name, emergency_contact_phone,
                created_at, updated_at, erased_at
           from member where id = $1`,
        [memberId],
      )
    ).rows[0];
    // RLS makes an out-of-scope id resolve to no row — nothing to export.
    if (!member) return { data: null };

    // Staff-only controller records (members' RLS policies do not expose these).
    const statusHistory = isStaff
      ? (await c.query<MemberStatusEvent>(MEMBER_STATUS_HISTORY_SQL, [memberId]))
          .rows
      : [];
    const invites = isStaff
      ? (
          await c.query<ExportedInvite>(
            `select id, email, status, expires_at, created_at, accepted_at
               from invite where member_id = $1
              order by created_at desc`,
            [memberId],
          )
        ).rows
      : [];
    // Staff-authored follow-up tasks (CRM-IDEAS "Apply now" #5) are another
    // staff-internal controller record — the member RLS policies never expose
    // member_task at all, so this is staff-only exactly like status history.
    const tasks = isStaff
      ? (
          await c.query<ExportedMemberTask>(
            `select id, title, due_at, completed_at, created_at
               from member_task where member_id = $1
              order by created_at desc`,
            [memberId],
          )
        ).rows
      : [];

    // Assignments + program summaries + exercises, both roles' own scope.
    const assignments = (
      await c.query<{
        assignment_id: string;
        status: string;
        assigned_at: string;
        program_id: string;
        name: string;
        description: string | null;
      }>(
        `select pa.id as assignment_id, pa.status, pa.assigned_at,
                p.id as program_id, p.name, p.description
           from program_assignment pa
           join program p on p.id = pa.program_id
          where pa.member_id = $1
          order by pa.assigned_at desc`,
        [memberId],
      )
    ).rows;

    const programIds = assignments.map((a) => a.program_id);
    const exercises =
      programIds.length > 0
        ? (
            await c.query<ExerciseRow>(
              `select id, program_id, position, name, sets, reps, rest, notes
                 from exercise
                where program_id = any($1::uuid[])
                order by program_id, position asc`,
              [programIds],
            )
          ).rows
        : [];

    const byProgram = new Map<string, ExerciseRow[]>();
    for (const ex of exercises) {
      const list = byProgram.get(ex.program_id) ?? [];
      list.push(ex);
      byProgram.set(ex.program_id, list);
    }

    const programs: ExportedProgram[] = assignments.map((a) => ({
      assignment_id: a.assignment_id,
      status: a.status,
      assigned_at: a.assigned_at,
      program: { id: a.program_id, name: a.name, description: a.description },
      exercises: byProgram.get(a.program_id) ?? [],
    }));

    // Workout logs are the member's OWN data — included for both staff DSAR and
    // member self-export (the member RLS policy exposes only their own logs).
    const workoutLogs = (
      await c.query<ExportedWorkoutLog>(
        `select wl.id, wl.program_id, p.name as program_name,
                wl.completed_at, wl.effort, wl.note
           from workout_log wl
           join program p on p.id = wl.program_id
          where wl.member_id = $1
          order by wl.completed_at desc`,
        [memberId],
      )
    ).rows;

    // Check-in (attendance) history and class bookings are the member's OWN
    // data too — included for both staff DSAR and member self-export, same as
    // workout logs above (the member RLS policies expose only their own rows:
    // check_ins_self_select, class_bookings_self_select).
    const checkIns = (
      await c.query<ExportedCheckIn>(
        `select id, method, checked_in_at
           from check_ins
          where member_id = $1
          order by checked_in_at desc`,
        [memberId],
      )
    ).rows;

    const classBookings = (
      await c.query<ExportedClassBooking>(
        `select cb.id as booking_id, cb.class_id, cl.name as class_name,
                cl.starts_at, cb.status, cb.booked_at, cb.cancelled_at
           from class_bookings cb
           join classes cl on cl.id = cb.class_id
          where cb.member_id = $1
          order by cb.booked_at desc`,
        [memberId],
      )
    ).rows;

    // Payment history, both halves. Also the member's own data, and exposed to a
    // member self-export by the same `*_self_select` pattern
    // (payment_events_self_select 0017, manual_payment_self_select 0026).
    //
    // Voided manual payments are INCLUDED deliberately. A void is a correction,
    // not a deletion: the member was told at some point that this payment was
    // recorded, so an export that quietly drops it is less complete than the
    // controller's own books. `voided_at` and `void_reason` travel with the row
    // so the subject can see it was reversed and why.
    const paymentEvents = (
      await c.query<ExportedPaymentEvent>(
        `select id, amount_cents, currency, status, occurred_at
           from payment_events
          where member_id = $1
          order by occurred_at desc`,
        [memberId],
      )
    ).rows;

    const manualPayments = (
      await c.query<ExportedManualPayment>(
        `select id, amount_cents, currency, method, reference, note,
                received_on, voided_at, void_reason, created_at
           from manual_payment
          where member_id = $1
          order by received_on desc`,
        [memberId],
      )
    ).rows;

    // Audit the export in the SAME transaction as the reads.
    await recordGdprEvent(c, {
      tenantId: identity.tenantId,
      action: "export",
      actorRole: isStaff ? "staff" : "member",
      actorUserId: isStaff
        ? await resolveActorUserId(c, identity.userId)
        : null,
      subjectMemberId: memberId,
      detail: {
        programs: programs.length,
        invites: invites.length,
        status_events: statusHistory.length,
        workout_logs: workoutLogs.length,
        check_ins: checkIns.length,
        class_bookings: classBookings.length,
        tasks: tasks.length,
      },
    });

    const data: MemberDataExport = {
      format: "alpha-crm.member-export",
      format_version: 1,
      subject: { type: "member", id: member.id },
      member,
      status_history: statusHistory,
      invites,
      programs,
      workout_logs: workoutLogs,
      check_ins: checkIns,
      class_bookings: classBookings,
      tasks,
      payment_events: paymentEvents,
      manual_payments: manualPayments,
    };
    return { data };
  });
}

// ===========================================================================
// Staff data subject (beta-gdpr-001/002).
//
// A staff user is a data subject too: they can request an export or erasure of
// their own personal data. The `users` table is staff-only under RLS
// (users_staff_all), so these run as staff and are scoped to the caller's gym —
// a cross-tenant `userId` resolves to no row, exactly like the member path.
// ===========================================================================

/** A subject's exported staff profile (all stored personal fields). */
export type ExportedStaff = {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  created_at: string;
  updated_at: string;
  erased_at: string | null;
};

/**
 * Provenance summary: how much of the gym's data this staff user authored. These
 * are counts only (not other subjects' personal data) — the staff member's own
 * activity record, which a DSAR may reasonably include.
 */
export type StaffActivitySummary = {
  programs_created: number;
  assignments_made: number;
  invites_created: number;
  status_changes_made: number;
};

/** The full export document for a staff data subject. */
export type StaffDataExport = {
  format: "alpha-crm.staff-export";
  format_version: 1;
  subject: { type: "staff"; id: string };
  staff: ExportedStaff;
  activity: StaffActivitySummary;
};

export type StaffExportResult = { data: StaffDataExport | null };

/**
 * Export `userId`'s staff personal data under `identity`, logging the action.
 * Returns `{ data: null }` when the user is not visible to the caller (not
 * found, or cross-tenant) — RLS makes an out-of-scope id resolve to no row.
 */
export async function exportStaffData(
  identity: Identity,
  userId: string,
): Promise<StaffExportResult> {
  return withTenantContext(identity, async (c) => {
    const staff = (
      await c.query<ExportedStaff>(
        `select id, email, full_name, role, created_at, updated_at, erased_at
           from users where id = $1`,
        [userId],
      )
    ).rows[0];
    if (!staff) return { data: null };

    const counts = (
      await c.query<{
        programs_created: string;
        assignments_made: string;
        invites_created: string;
        status_changes_made: string;
      }>(
        `select
           (select count(*) from program where created_by = $1)            as programs_created,
           (select count(*) from program_assignment where assigned_by = $1) as assignments_made,
           (select count(*) from invite where created_by = $1)             as invites_created,
           (select count(*) from member_status_event where changed_by = $1) as status_changes_made`,
        [userId],
      )
    ).rows[0];

    await recordGdprEvent(c, {
      tenantId: identity.tenantId,
      action: "export",
      actorRole: "staff",
      actorUserId: await resolveActorUserId(c, identity.userId),
      subjectUserId: userId,
      detail: { subject: "staff" },
    });

    const data: StaffDataExport = {
      format: "alpha-crm.staff-export",
      format_version: 1,
      subject: { type: "staff", id: staff.id },
      staff,
      activity: {
        programs_created: Number(counts.programs_created),
        assignments_made: Number(counts.assignments_made),
        invites_created: Number(counts.invites_created),
        status_changes_made: Number(counts.status_changes_made),
      },
    };
    return { data };
  });
}

// ===========================================================================
// Right to erasure / anonymisation (beta-gdpr-002).
//
// We ANONYMISE rather than hard-delete: the subject row is kept but every field
// that could identify the person is tombstoned/nulled, and `erased_at` is
// stamped. This preserves referential integrity — programs, assignments, status
// history and invites that reference the subject remain valid — while removing
// the personal data, and never touches another tenant's rows (RLS + the
// tenant-scoped client guarantee that). The action is idempotent: re-erasing an
// already-erased subject is a no-op that still reports success.
// ===========================================================================

export type EraseResult =
  | { ok: true; alreadyErased: boolean }
  | { ok: false; reason: "not_found" | "forbidden" };

/**
 * Erase (anonymise) a member: tombstone profile PII, scrub their invite emails,
 * revoke any pending invite, sever portal access, and stamp `erased_at`. The
 * row and all its FKs survive. Best-effort deletes the Supabase auth account
 * after the DB transaction commits so the member can no longer sign in.
 */
export async function anonymiseMember(
  identity: Identity,
  memberId: string,
): Promise<EraseResult> {
  const outcome = await withTenantContext(identity, async (c) => {
    const member = (
      await c.query<{ id: string; auth_user_id: string | null; erased_at: string | null }>(
        `select id, auth_user_id, erased_at from member where id = $1`,
        [memberId],
      )
    ).rows[0];
    // RLS makes an out-of-scope id resolve to no row.
    if (!member) return { ok: false as const, reason: "not_found" as const };

    if (member.erased_at) {
      return { ok: true as const, alreadyErased: true, authUserId: null };
    }

    // pin_code/qr_token are check-in CREDENTIALS, not profile PII, but an
    // erased member must lose kiosk access too — otherwise they could still
    // check in (and accrue new attendance rows) after "erasure". qr_token is
    // NOT NULL, so it is rotated (not cleared) to invalidate the old code.
    await c.query(
      `update member
          set full_name = $2, email = null, phone = null, notes = null,
              emergency_contact_name = null, emergency_contact_phone = null,
              photo_url = null, pin_code = null, qr_token = gen_random_uuid(),
              status = 'inactive', auth_user_id = null,
              erased_at = now(), updated_at = now()
        where id = $1`,
      [memberId, ERASED_MEMBER_NAME],
    );

    // A face is the most identifying data the record holds, and it lives in its
    // own table (0019) — so nulling `photo_url` above does NOT remove it. The
    // row is DELETED rather than tombstoned: unlike the member row nothing
    // references it, so there is no referential integrity to preserve, and an
    // erasure that leaves the photograph behind is not an erasure.
    await c.query("delete from member_photo where member_id = $1", [memberId]);

    // Scrub PII held on the member's invites and invalidate any pending one.
    await c.query(
      `update invite
          set email = $2,
              status = case when status = 'pending' then 'revoked' else status end
        where member_id = $1`,
      [memberId, ERASED_INVITE_EMAIL],
    );

    // Scrub free-text notes on the member's workout logs (may contain PII). The
    // rows themselves are kept anonymised — they carry only the (now tombstoned)
    // member_id and aggregate effort/timing, preserving referential integrity.
    await c.query(`update workout_log set note = null where member_id = $1`, [
      memberId,
    ]);

    // Scrub free-text titles on the member's follow-up tasks (may contain PII,
    // e.g. "ask about her surgery recovery") — same rationale as workout-log
    // notes. Unlike workout_log, staff already hold full UPDATE on member_task
    // (member_task_staff_all is a `for all` policy), so no extra grant is needed
    // here — this scrub cannot hit the missing-UPDATE-grant class of bug fixed
    // for workout_log.
    await c.query(`update member_task set title = $2 where member_id = $1`, [
      memberId,
      ERASED_TASK_TITLE,
    ]);

    // Scrub the free-text headline on the member's derived-claim ledger rows
    // (0021) — a brief's headline is built by interpolating the member's full
    // name straight into the sentence (`buildAtRiskBrief`, lib/briefs.ts), so
    // it is exactly the kind of PII-bearing free text workout-log notes and
    // task titles already get scrubbed for. Unlike those two, `suggestions`
    // rows are kept regardless of status (pending/accepted/dismissed) — the
    // row itself is the audit trail of what was suggested and decided, only
    // the identifying sentence is tombstoned.
    await c.query(
      `update suggestions set headline = $2 where member_id = $1`,
      [memberId, ERASED_SUGGESTION_HEADLINE],
    );

    // Scrub the member's own words on any erasure request they filed (0026).
    // The request row itself is KEPT — it is the controller's evidence that a
    // subject request was received and answered, which must outlive the data it
    // concerned — but `reason` is free text the member wrote about themselves
    // ("I'm moving away", "after what happened in class") and is exactly the
    // PII-bearing prose the scrubs above exist for. The dates and the decision,
    // which are what the evidence needs, survive.
    await c.query(
      `update member_deletion_request set reason = null where member_id = $1`,
      [memberId],
    );

    // Off-card payments (0026) carry two staff-authored free-text fields about
    // this member — `note` and `void_reason` ("paid cash at the desk, said she's
    // moving to Limassol") — plus `reference`, which for a SEPA transfer can be a
    // bank reference containing the payer's own name. All three are scrubbed.
    //
    // The ROWS ARE KEPT, unlike member_photo. These are financial records: the
    // gym has a statutory retention obligation for its books that survives an
    // erasure request, and Art. 17(3)(b) exempts processing required for
    // compliance with a legal obligation. So the amount, method and date stay
    // (they are the controller's accounts, not the subject's profile) while
    // everything identifying is removed and the row's member_id points at an
    // already-tombstoned member. `docs/DATA_RETENTION.md` states this.
    //
    // NOT filtered on `voided_at`: a voided row's free text is exactly as
    // identifying as a live one's.
    await c.query(
      `update manual_payment
          set note = null,
              reference = null,
              void_reason = case when void_reason is null then null else $2 end
        where member_id = $1`,
      [memberId, ERASED_PAYMENT_TEXT],
    );

    await recordGdprEvent(c, {
      tenantId: identity.tenantId,
      action: "erasure",
      actorRole: identity.role,
      actorUserId:
        identity.role === "staff"
          ? await resolveActorUserId(c, identity.userId)
          : null,
      subjectMemberId: memberId,
      detail: { subject: "member" },
    });

    return {
      ok: true as const,
      alreadyErased: false,
      authUserId: member.auth_user_id,
    };
  });

  // Best-effort, post-commit: remove the auth account so sign-in is impossible.
  if (outcome.ok && !outcome.alreadyErased && outcome.authUserId) {
    await deleteAuthUser(outcome.authUserId);
  }

  return outcome.ok
    ? { ok: true, alreadyErased: outcome.alreadyErased }
    : outcome;
}

/**
 * Erase (anonymise) a staff user: tombstone their email (kept unique per tenant
 * via the id suffix to satisfy the unique constraint), null their name, sever
 * portal/auth linkage and stamp `erased_at`. Authored rows (programs,
 * assignments, etc.) keep their FK — they record activity, not personal data.
 *
 * A staff user cannot erase THEMSELVES (that would lock the actor out
 * mid-request and remove the audit actor); the caller is identified via the
 * session, so this is enforced here rather than trusting the UI.
 */
export async function anonymiseStaff(
  identity: Identity,
  userId: string,
): Promise<EraseResult> {
  const outcome = await withTenantContext(identity, async (c) => {
    const actorUserId = await resolveActorUserId(c, identity.userId);
    if (actorUserId && actorUserId === userId) {
      return { ok: false as const, reason: "forbidden" as const };
    }

    const staff = (
      await c.query<{ id: string; auth_user_id: string | null; erased_at: string | null }>(
        `select id, auth_user_id, erased_at from users where id = $1`,
        [userId],
      )
    ).rows[0];
    if (!staff) return { ok: false as const, reason: "not_found" as const };

    if (staff.erased_at) {
      return {
        ok: true as const,
        alreadyErased: true,
        authUserId: null,
        actorUserId,
      };
    }

    await c.query(
      `update users
          set email = 'erased-' || id::text || '@invalid.example',
              full_name = null, auth_user_id = null,
              erased_at = now(), updated_at = now()
        where id = $1`,
      [userId],
    );

    await recordGdprEvent(c, {
      tenantId: identity.tenantId,
      action: "erasure",
      actorRole: "staff",
      actorUserId,
      subjectUserId: userId,
      detail: { subject: "staff" },
    });

    return {
      ok: true as const,
      alreadyErased: false,
      authUserId: staff.auth_user_id,
      actorUserId,
    };
  });

  if (outcome.ok && !outcome.alreadyErased && outcome.authUserId) {
    await deleteAuthUser(outcome.authUserId);
  }

  return outcome.ok
    ? { ok: true, alreadyErased: outcome.alreadyErased }
    : outcome;
}
