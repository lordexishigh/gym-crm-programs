import { withTenantContext, type Identity } from "../db";
import { sendErasureConfirmationEmail } from "../notifications";
import { anonymiseMember } from "./export";
import { recordGdprEvent, resolveActorUserId } from "./audit";

/**
 * Member-initiated right-to-erasure workflow (beta-gdpr-002).
 *
 * `anonymiseMember` (lib/gdpr/export.ts) is the MECHANISM — it tombstones a
 * member's personal data. This module is the WORKFLOW around it, which is what
 * Art. 17 actually requires of a controller:
 *
 *   1. the data subject asks, from their own portal      -> `submitDeletionRequest`
 *   2. the gym sees the ask as pending work              -> `listPendingDeletionRequests`
 *   3. the gym decides, and the decision is recorded     -> `completeDeletionRequest` / `declineDeletionRequest`
 *   4. the subject is told the outcome                   -> confirmation email, from (3)
 *
 * Every query runs through `withTenantContext` as the RLS-bound `app_user`, so a
 * member can only ever file (and read) their OWN request and staff only ever see
 * their own gym's — the `member_deletion_request` policies in migration 0026,
 * not these predicates, are the boundary.
 */

export type DeletionRequestStatus = "pending" | "completed" | "declined";
export type ConfirmationEmailStatus = "sent" | "failed" | "skipped";

/** How the member's own portal sees their request. */
export type MemberDeletionRequestView = {
  id: string;
  status: DeletionRequestStatus;
  requested_at: string;
  decided_at: string | null;
  decision_note: string | null;
};

/** A pending request as the staff queue lists it, with the subject's name. */
export type PendingDeletionRequestRow = {
  id: string;
  member_id: string;
  member_name: string;
  member_email: string | null;
  reason: string | null;
  requested_at: string;
};

/** Free-text cap on the member's reason / the staff decision note. */
const NOTE_MAX = 1000;

/**
 * Normalise an optional free-text note: trimmed, capped, empty becomes null.
 * Pure, so the Server Action can validate before any round trip.
 */
export function normaliseNote(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, NOTE_MAX);
}

export type SubmitResult =
  | { ok: true; alreadyPending: boolean }
  | { ok: false; reason: "not_found" | "already_erased" };

/**
 * File an erasure request for the signed-in member.
 *
 * Idempotent from the member's point of view: the partial unique index in
 * migration 0026 allows only one `pending` row per member, so a second tap
 * reports the existing request rather than queuing a duplicate for staff to
 * decide on twice. An already-erased member has nothing left to erase, which is
 * reported distinctly so the portal can say so instead of pretending to file.
 */
export async function submitDeletionRequest(
  identity: Identity,
  memberId: string,
  reason: string | null,
): Promise<SubmitResult> {
  return withTenantContext(identity, async (c) => {
    // RLS (`member_self_select`, migration 0002) makes this the caller's own row
    // under a member session; a crafted id resolves to nothing.
    const member = (
      await c.query<{ erased_at: string | null }>(
        "select erased_at from member where id = $1",
        [memberId],
      )
    ).rows[0];
    if (!member) return { ok: false as const, reason: "not_found" as const };
    if (member.erased_at) {
      return { ok: false as const, reason: "already_erased" as const };
    }

    // `on conflict do nothing` against the pending partial index: the existing
    // request wins and we report it, with no read-then-insert race.
    const inserted = await c.query(
      `insert into member_deletion_request (tenant_id, member_id, reason)
       values ($1, $2, $3)
       on conflict do nothing`,
      [identity.tenantId, memberId, reason],
    );

    return { ok: true as const, alreadyPending: (inserted.rowCount ?? 0) === 0 };
  });
}

/**
 * The member's most recent request, for the portal panel. Null when they have
 * never asked. Read under the member's own RLS policy
 * (`member_deletion_request_member_select`).
 */
export async function latestDeletionRequestForMember(
  identity: Identity,
  memberId: string,
): Promise<MemberDeletionRequestView | null> {
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<MemberDeletionRequestView>(
      `select id, status, requested_at, decided_at, decision_note
         from member_deletion_request
        where member_id = $1
        order by requested_at desc
        limit 1`,
      [memberId],
    );
    return rows[0] ?? null;
  });
}

/**
 * The gym's queue of erasure requests still awaiting a decision, oldest first —
 * the statutory clock runs from the request date, so the oldest is the most
 * urgent, the opposite of the newest-first ordering most lists here use.
 */
export async function listPendingDeletionRequests(
  identity: Identity,
): Promise<PendingDeletionRequestRow[]> {
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<PendingDeletionRequestRow>(
      `select r.id, r.member_id, r.reason, r.requested_at,
              m.full_name as member_name,
              m.email     as member_email
         from member_deletion_request r
         join member m on m.id = r.member_id
        where r.status = 'pending'
        order by r.requested_at asc`,
    );
    return rows;
  });
}

export type DecisionResult =
  | { ok: true; emailed?: ConfirmationEmailStatus }
  | { ok: false; reason: "not_found" };

/**
 * Confirm a pending request: anonymise the member, then tell them it is done.
 *
 * The ORDER here is the whole point, and it is load-bearing. The confirmation
 * has to reach the member at the address the gym holds for them — and that
 * address is itself personal data the erasure removes. So the contact details
 * are read BEFORE `anonymiseMember` runs and used after it commits; reading them
 * afterwards would find a tombstone and the subject would never be told their
 * request was honoured. This is also why migration 0026 stores no copy of the
 * address: it only has to survive the width of this function, not forever.
 *
 * The three steps are separate transactions rather than one, because
 * `anonymiseMember` owns its own (and must, so the erasure commits atomically
 * with its audit event). A crash between them leaves the member erased with the
 * request still pending — visible, re-runnable, and safe: the second attempt
 * finds `alreadyErased` and closes the request out. The failure mode in the
 * other direction (request closed, data still present) is the one that would
 * matter, and this ordering cannot produce it.
 */
export async function completeDeletionRequest(
  identity: Identity,
  requestId: string,
): Promise<DecisionResult> {
  // 1. Resolve the request + the subject's contact details, while they exist.
  const subject = await withTenantContext(identity, async (c) => {
    const { rows } = await c.query<{
      member_id: string;
      member_name: string;
      member_email: string | null;
      gym_name: string;
    }>(
      `select r.member_id,
              m.full_name as member_name,
              m.email     as member_email,
              g.name      as gym_name
         from member_deletion_request r
         join member m on m.id = r.member_id
         join gym    g on g.id = r.tenant_id
        where r.id = $1 and r.status = 'pending'`,
      [requestId],
    );
    return rows[0] ?? null;
  });
  if (!subject) return { ok: false, reason: "not_found" };

  // 2. Erase. Tombstones the member row (and its invites, logs, tasks, briefs,
  //    photo) and writes the `erasure` audit event, in one transaction.
  const erased = await anonymiseMember(identity, subject.member_id);
  if (!erased.ok) return { ok: false, reason: "not_found" };

  // 3. Tell the subject. Best-effort: a mail outage must not leave the request
  //    open (the data IS gone), so the outcome is recorded on the row instead —
  //    which is also the controller's evidence of whether it notified them.
  let emailed: ConfirmationEmailStatus;
  if (!subject.member_email) {
    emailed = "skipped";
  } else {
    const sent = await sendErasureConfirmationEmail({
      to: subject.member_email,
      memberName: subject.member_name,
      gymName: subject.gym_name,
    });
    emailed = sent ? "sent" : "failed";
  }

  // 4. Close the request and record who decided, plus the notification outcome.
  await withTenantContext(identity, async (c) => {
    const actorUserId = await resolveActorUserId(c, identity.userId);
    await c.query(
      `update member_deletion_request
          set status = 'completed', decided_at = now(), decided_by = $2,
              confirmation_email = $3
        where id = $1 and status = 'pending'`,
      [requestId, actorUserId, emailed],
    );
    // The DECISION is a distinct auditable act from the erasure itself: the
    // erasure event records that data was removed, this records that a subject
    // request was answered (and how the subject was told).
    await recordGdprEvent(c, {
      tenantId: identity.tenantId,
      action: "erasure",
      actorRole: "staff",
      actorUserId,
      subjectMemberId: subject.member_id,
      detail: {
        subject: "member",
        request_id: requestId,
        decision: "completed",
        confirmation_email: emailed,
      },
    });
  });

  return { ok: true, emailed };
}

/**
 * Decline a pending request, with a reason the member can read in their portal.
 *
 * Refusal is a legitimate outcome — Art. 17(3) carves out data a controller must
 * keep (an unpaid invoice, an accident report, a statutory retention period) —
 * but it is only lawful if the subject is TOLD, so the note is required rather
 * than optional and is surfaced back in the portal panel.
 */
export async function declineDeletionRequest(
  identity: Identity,
  requestId: string,
  note: string,
): Promise<DecisionResult> {
  const updated = await withTenantContext(identity, async (c) => {
    const actorUserId = await resolveActorUserId(c, identity.userId);
    const res = await c.query<{ member_id: string }>(
      `update member_deletion_request
          set status = 'declined', decided_at = now(), decided_by = $2,
              decision_note = $3
        where id = $1 and status = 'pending'
        returning member_id`,
      [requestId, actorUserId, note],
    );
    const row = res.rows[0];
    if (!row) return null;

    await recordGdprEvent(c, {
      tenantId: identity.tenantId,
      action: "erasure",
      actorRole: "staff",
      actorUserId,
      subjectMemberId: row.member_id,
      detail: {
        subject: "member",
        request_id: requestId,
        decision: "declined",
      },
    });
    return row;
  });

  // 0 rows: a cross-tenant id (invisible under RLS) or already decided.
  if (!updated) return { ok: false, reason: "not_found" };
  return { ok: true };
}
