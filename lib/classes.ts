import { withAdminContext, withTenantContext, type Identity } from "@/lib/db";

/**
 * Class scheduling (market gap #4): staff-defined classes with a capacity
 * limit, member booking, and waitlist auto-promotion when a booked spot
 * cancels. Mirrors lib/members.ts / lib/portal.ts: pure validation here, DB
 * access via withTenantContext (RLS-scoped) with one narrow, documented
 * withAdminContext step for the cross-member waitlist promotion (see
 * `cancelBooking`).
 */

export type ClassRow = {
  id: string;
  tenant_id: string;
  name: string;
  instructor_name: string | null;
  starts_at: string;
  duration_minutes: number;
  capacity: number;
  created_at: string;
  updated_at: string;
};

/** A class plus its current booked/waitlisted counts, for the staff calendar. */
export type ClassWithCounts = ClassRow & {
  booked_count: number;
  waitlisted_count: number;
};

export type BookingStatus = "booked" | "waitlisted" | "cancelled";

export type ClassBookingRow = {
  id: string;
  tenant_id: string;
  class_id: string;
  member_id: string;
  status: BookingStatus;
  booked_at: string;
  cancelled_at: string | null;
  /** Set when this row was auto-promoted off the waitlist (see `promoteFromWaitlist`). */
  promoted_at: string | null;
};

/** A class from the member's point of view, with their own booking (if any). */
export type MemberClassView = ClassRow & {
  booking_id: string | null;
  booking_status: BookingStatus | null;
  booking_promoted_at: string | null;
  booked_count: number;
};

export type ClassInput = {
  name: string;
  instructorName: string | null;
  startsAt: Date;
  durationMinutes: number;
  capacity: number;
};

export type ClassValidationResult =
  | { ok: true; value: ClassInput }
  | { ok: false; error: string };

const NAME_MAX = 120;

/** Validate + normalise a staff-submitted class form. */
export function validateClassInput(raw: {
  name?: unknown;
  instructorName?: unknown;
  startsAt?: unknown;
  durationMinutes?: unknown;
  capacity?: unknown;
}): ClassValidationResult {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return { ok: false, error: "Class name is required." };
  if (name.length > NAME_MAX) {
    return { ok: false, error: `Class name is too long (max ${NAME_MAX} characters).` };
  }

  const instructorRaw =
    typeof raw.instructorName === "string" ? raw.instructorName.trim() : "";
  const instructorName = instructorRaw.length > 0 ? instructorRaw : null;

  const startsAtRaw = typeof raw.startsAt === "string" ? raw.startsAt : "";
  const startsAt = new Date(startsAtRaw);
  if (!startsAtRaw || Number.isNaN(startsAt.getTime())) {
    return { ok: false, error: "Enter a valid class date/time." };
  }

  const durationRaw =
    typeof raw.durationMinutes === "string" ? Number.parseInt(raw.durationMinutes, 10) : NaN;
  if (!Number.isFinite(durationRaw) || durationRaw <= 0 || durationRaw > 600) {
    return { ok: false, error: "Duration must be between 1 and 600 minutes." };
  }

  const capacityRaw =
    typeof raw.capacity === "string" ? Number.parseInt(raw.capacity, 10) : NaN;
  if (!Number.isFinite(capacityRaw) || capacityRaw <= 0 || capacityRaw > 1000) {
    return { ok: false, error: "Capacity must be between 1 and 1000." };
  }

  return {
    ok: true,
    value: {
      name,
      instructorName,
      startsAt,
      durationMinutes: durationRaw,
      capacity: capacityRaw,
    },
  };
}

/** Upcoming classes with live booked/waitlisted counts, for the staff calendar. */
export async function listUpcomingClasses(identity: Identity): Promise<ClassWithCounts[]> {
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<ClassWithCounts>(
      `select cl.id, cl.tenant_id, cl.name, cl.instructor_name, cl.starts_at,
              cl.duration_minutes, cl.capacity, cl.created_at, cl.updated_at,
              coalesce(b.booked_count, 0)::int as booked_count,
              coalesce(b.waitlisted_count, 0)::int as waitlisted_count
         from classes cl
         left join (
           select class_id,
                  count(*) filter (where status = 'booked') as booked_count,
                  count(*) filter (where status = 'waitlisted') as waitlisted_count
             from class_bookings
            group by class_id
         ) b on b.class_id = cl.id
        where cl.starts_at >= now() - interval '1 day'
        order by cl.starts_at asc`,
    );
    return rows;
  });
}

/** The member-facing upcoming schedule, with the member's own booking status joined in. */
export async function listUpcomingClassesForMember(
  identity: Identity,
  memberId: string,
): Promise<MemberClassView[]> {
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<MemberClassView>(
      `select cl.id, cl.tenant_id, cl.name, cl.instructor_name, cl.starts_at,
              cl.duration_minutes, cl.capacity, cl.created_at, cl.updated_at,
              mine.id as booking_id, mine.status as booking_status,
              mine.promoted_at as booking_promoted_at,
              coalesce(b.booked_count, 0)::int as booked_count
         from classes cl
         left join class_bookings mine
           on mine.class_id = cl.id and mine.member_id = $1 and mine.status <> 'cancelled'
         left join (
           select class_id, count(*) as booked_count
             from class_bookings
            where status = 'booked'
            group by class_id
         ) b on b.class_id = cl.id
        where cl.starts_at >= now()
        order by cl.starts_at asc`,
      [memberId],
    );
    return rows;
  });
}

/** The member's confirmed upcoming bookings (portal "upcoming bookings" section). */
export async function upcomingBookingsForMember(
  identity: Identity,
  memberId: string,
): Promise<(ClassRow & { booking_id: string; booking_status: BookingStatus })[]> {
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query(
      `select cl.id, cl.tenant_id, cl.name, cl.instructor_name, cl.starts_at,
              cl.duration_minutes, cl.capacity, cl.created_at, cl.updated_at,
              cb.id as booking_id, cb.status as booking_status
         from class_bookings cb
         join classes cl on cl.id = cb.class_id
        where cb.member_id = $1
          and cb.status in ('booked', 'waitlisted')
          and cl.starts_at >= now()
        order by cl.starts_at asc`,
      [memberId],
    );
    return rows;
  });
}

/** A class's roster (bookings + waitlist) with member names, for the staff detail view. */
export async function classRoster(
  identity: Identity,
  classId: string,
): Promise<{ class: ClassRow | null; bookings: (ClassBookingRow & { member_name: string })[] }> {
  return withTenantContext(identity, async (c) => {
    const cls = (
      await c.query<ClassRow>(
        `select id, tenant_id, name, instructor_name, starts_at, duration_minutes,
                capacity, created_at, updated_at
           from classes where id = $1`,
        [classId],
      )
    ).rows[0] ?? null;

    const bookings = (
      await c.query<ClassBookingRow & { member_name: string }>(
        `select cb.id, cb.tenant_id, cb.class_id, cb.member_id, cb.status,
                cb.booked_at, cb.cancelled_at, cb.promoted_at, m.full_name as member_name
           from class_bookings cb
           join member m on m.id = cb.member_id
          where cb.class_id = $1 and cb.status <> 'cancelled'
          order by cb.status asc, cb.booked_at asc`,
        [classId],
      )
    ).rows;

    return { class: cls, bookings };
  });
}

export async function createClass(
  identity: Identity,
  input: ClassInput,
  instructorId: string | null,
): Promise<string> {
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `insert into classes (tenant_id, name, instructor_id, instructor_name, starts_at, duration_minutes, capacity)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [
        identity.tenantId,
        input.name,
        instructorId,
        input.instructorName,
        input.startsAt.toISOString(),
        input.durationMinutes,
        input.capacity,
      ],
    );
    return rows[0].id;
  });
}

export type BookResult =
  | { ok: true; status: "booked" | "waitlisted" }
  | { ok: false; error: string };

/**
 * Why a non-'active' membership cannot book a class.
 *
 * Migration 0013 deliberately splits the two states this product needs to keep
 * apart: `member.status` is the portal/roster flag, `member.membership_status`
 * is the BILLING lifecycle. Class booking consumes a paid entitlement, so it
 * gates on the billing one — while the portal (programs, workout logging)
 * gates on neither and stays open. That asymmetry is the point: a member who
 * pauses for the summer keeps their rehab programme and keeps logging
 * sessions, and simply cannot take a class slot they are not paying for.
 *
 * Worded per status because "you can't book" is actively misleading for a
 * freeze — the member still has a portal, and telling them otherwise is what
 * makes them leave.
 */
const BOOKING_BLOCKED_GENERIC =
  "Your membership is not active, so class booking is unavailable. Speak to your gym.";

const BOOKING_BLOCKED_REASON: Record<string, string> = {
  frozen:
    "Your membership is paused, so class booking is unavailable. Your training programs are still here, and you can keep logging workouts.",
  expired:
    "Your membership has expired, so class booking is unavailable. Speak to your gym to renew.",
  cancelled:
    "Your membership is cancelled, so class booking is unavailable. Speak to your gym to restart it.",
};

/**
 * Book a member into a class: confirmed if under capacity, waitlisted
 * otherwise — and only if their membership is billing-active at all (see
 * `BOOKING_BLOCKED_REASON`; until this gate existed, an expired or cancelled
 * member could take class slots indefinitely).
 *
 * **Admin context, and why the count has to run there.** The previous version
 * ran everything under the member's own `withTenantContext` session. That
 * looked reasonable but was silently broken: `class_bookings_self_select`
 * (0015) scopes a member's SELECT to `member_id = app_current_member()`, so
 * the "how many are already booked" count could only ever see the CALLING
 * member's own rows — which is always zero at this point, since they don't
 * have a booking yet. Capacity was therefore never actually enforced for
 * self-booking; every request landed as `'booked'` regardless of how full the
 * class was, and the waitlist this feature exists to support could never
 * trigger from a member booking. Fixed by moving the read (and now the write)
 * into `withAdminContext`, the same narrowly-scoped, explicitly
 * tenant-matched pattern `promoteFromWaitlist` already uses for its own
 * cross-visibility need.
 *
 * Because this bypasses RLS, the `member_id = app_current_member()` check the
 * self-insert policy used to provide is re-asserted in application code
 * below, and `tenant_id` is matched explicitly in every clause. `select ...
 * for update` on the class row serializes concurrent bookers of the SAME
 * class, closing the small over-capacity race the previous version accepted
 * as a trade-off (a lock was unavailable from a member session; it isn't
 * unavailable from admin context).
 */
export async function bookClass(
  identity: Identity,
  memberId: string,
  classId: string,
): Promise<BookResult> {
  if (identity.role !== "member" || identity.memberId !== memberId) {
    return { ok: false, error: "Not authorized to book this class." };
  }

  return withAdminContext(async (c) => {
    // Billing gate, before the class row is locked — a blocked member should
    // never hold a lock other bookers of the same class are queued behind.
    // `tenant_id` is matched explicitly because admin context bypasses RLS.
    const mem = (
      await c.query<{ membership_status: "active" | "expired" | "frozen" | "cancelled" }>(
        "select membership_status from member where id = $1 and tenant_id = $2",
        [memberId, identity.tenantId],
      )
    ).rows[0];
    if (!mem) return { ok: false, error: "Member not found." };
    // Allowlist, not a blocklist: a fifth status added to 0013's CHECK must
    // block booking by default rather than silently become bookable, and must
    // still produce a real message rather than `undefined`.
    if (mem.membership_status !== "active") {
      return {
        ok: false,
        error: BOOKING_BLOCKED_REASON[mem.membership_status] ?? BOOKING_BLOCKED_GENERIC,
      };
    }

    const cls = (
      await c.query<{ capacity: number }>(
        "select capacity from classes where id = $1 and tenant_id = $2 for update",
        [classId, identity.tenantId],
      )
    ).rows[0];
    if (!cls) return { ok: false, error: "Class not found." };

    const { rows: countRows } = await c.query<{ count: string }>(
      "select count(*)::text as count from class_bookings where class_id = $1 and tenant_id = $2 and status = 'booked'",
      [classId, identity.tenantId],
    );
    const bookedCount = Number(countRows[0]?.count ?? "0");
    const status = bookedCount < cls.capacity ? "booked" : "waitlisted";

    try {
      await c.query(
        `insert into class_bookings (tenant_id, class_id, member_id, status)
         values ($1, $2, $3, $4)`,
        [identity.tenantId, classId, memberId, status],
      );
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: unknown }).code === "23505"
      ) {
        return { ok: false, error: "You already have a spot (or a waitlist place) in this class." };
      }
      throw err;
    }

    return { ok: true, status };
  });
}

/**
 * A booking that was just moved off the waitlist onto a confirmed spot, with
 * everything the caller needs to email the member — so the notify step never
 * has to re-query per promotion.
 */
export type PromotedBooking = {
  booking_id: string;
  member_id: string;
  member_name: string;
  member_email: string | null;
  class_id: string;
  class_name: string;
  starts_at: string;
};

/**
 * Fill every currently-free spot in a class from the head of its waitlist,
 * oldest waiting first, and return who was promoted.
 *
 * This is the auto-promotion handler. It is driven by `cancelBooking` (the
 * common case: a member or the front desk frees a confirmed spot) and can also
 * be invoked directly by staff — see `promoteFromWaitlistAction` in
 * app/dashboard/classes/actions.ts — to reconcile a class whose vacancies were
 * created some other way.
 *
 * Design notes:
 *
 * - **Admin context.** Promotion writes ANOTHER member's booking row. No RLS
 *   policy permits that from a member session, and rightly so, so this uses
 *   `withAdminContext` — the same narrowly-scoped admin-path pattern as invite
 *   acceptance. Because that bypasses RLS, `tenant_id` is matched EXPLICITLY in
 *   every clause below; a caller cannot reach across gyms by passing a foreign
 *   class id.
 * - **Capacity-driven, not delta-driven.** It promotes `capacity - booked`
 *   members rather than assuming exactly one spot just opened. That makes it
 *   idempotent (nothing free ⇒ nothing promoted ⇒ safe to call twice) and
 *   self-healing if a booking race ever left a class under-filled with people
 *   still waiting.
 * - **Past classes are skipped.** `starts_at >= now()` means cancelling out of
 *   a class that already happened never promotes someone into it — which would
 *   otherwise email a member "a spot opened up" for a session that is over.
 * - **Concurrency.** `for update skip locked` on the waitlist selection means
 *   two simultaneous cancellations promote two DIFFERENT members instead of
 *   racing over one row. The whole thing is a single statement, so the
 *   count-free-spots and take-the-waitlist-head steps cannot interleave.
 * - **LIMIT guard.** `coalesce(..., 0)` matters: a bare `limit (select …)` that
 *   yields NULL means "no limit" in Postgres, which would promote the entire
 *   waitlist whenever the class is missing or already started.
 */
export async function promoteFromWaitlist(
  tenantId: string,
  classId: string,
): Promise<PromotedBooking[]> {
  return withAdminContext(async (c) => {
    const { rows } = await c.query<PromotedBooking>(
      `with target as (
         select cl.id, cl.capacity, cl.name, cl.starts_at
           from classes cl
          where cl.id = $1 and cl.tenant_id = $2 and cl.starts_at >= now()
       ),
       free as (
         select t.capacity - count(cb.id) as slots
           from target t
           left join class_bookings cb
             on cb.class_id = t.id and cb.tenant_id = $2 and cb.status = 'booked'
          group by t.capacity
       ),
       next_up as (
         select cb.id
           from class_bookings cb
          where cb.class_id = $1
            and cb.tenant_id = $2
            and cb.status = 'waitlisted'
          order by cb.booked_at asc
          limit coalesce((select greatest(slots, 0) from free), 0)
          for update skip locked
       ),
       promoted as (
         update class_bookings cb
            set status = 'booked', promoted_at = now()
          where cb.id in (select id from next_up)
          returning cb.id, cb.member_id
       )
       select p.id as booking_id, p.member_id,
              m.full_name as member_name, m.email as member_email,
              t.id as class_id, t.name as class_name, t.starts_at
         from promoted p
         join member m on m.id = p.member_id and m.tenant_id = $2
         cross join target t`,
      [classId, tenantId],
    );
    return rows;
  });
}

/**
 * Promotions that happened but were never successfully emailed.
 *
 * Migration 0019 created `idx_class_bookings_promotion_unnotified` for exactly
 * this query — "the notify sweep looks for promoted-but-not-yet-notified rows" —
 * but no sweep existed to run it. Notification happened only inline, on the
 * `cancelBooking` path that caused the promotion, so any send that failed there
 * (a provider blip, or simply a deployment with no `RESEND_API_KEY` — which is
 * production today) left `promotion_notified_at` null forever with nothing to
 * retry it. The member keeps their spot and is never told, which is the precise
 * failure 0019 was written to prevent.
 *
 * `waitlist_promotion_notify` (lib/task-handlers.ts) is that sweep. Admin
 * context, `tenant_id` matched explicitly, for the same reason as the promotion
 * itself: these rows belong to other members.
 *
 * Past classes are excluded — emailing "a spot opened up" for a session that has
 * already happened is worse than saying nothing, and those rows would otherwise
 * be retried forever.
 */
export async function unnotifiedPromotions(
  tenantId: string,
  limit = 100,
): Promise<PromotedBooking[]> {
  const capped = Math.min(Math.max(1, Math.floor(limit)), 500);
  return withAdminContext(async (c) => {
    const { rows } = await c.query<PromotedBooking>(
      `select cb.id as booking_id, cb.member_id,
              m.full_name as member_name, m.email as member_email,
              cl.id as class_id, cl.name as class_name, cl.starts_at
         from class_bookings cb
         join member  m  on m.id  = cb.member_id and m.tenant_id  = $1
         join classes cl on cl.id = cb.class_id  and cl.tenant_id = $1
        where cb.tenant_id = $1
          and cb.promoted_at is not null
          and cb.promotion_notified_at is null
          and cb.status = 'booked'
          and cl.starts_at >= now()
        order by cb.promoted_at asc
        limit $2`,
      [tenantId, capped],
    );
    return rows;
  });
}

/**
 * Stamp `promotion_notified_at` on bookings whose promoted member was
 * successfully emailed, so a later sweep or retry never double-sends. Runs in
 * admin context for the same reason the promotion itself does: the rows belong
 * to other members. A no-op for an empty list.
 */
export async function markPromotionNotified(
  tenantId: string,
  bookingIds: string[],
): Promise<void> {
  if (bookingIds.length === 0) return;
  await withAdminContext(async (c) => {
    await c.query(
      `update class_bookings
          set promotion_notified_at = now()
        where id = any($1::uuid[])
          and tenant_id = $2
          and promotion_notified_at is null`,
      [bookingIds, tenantId],
    );
  });
}

export type CancelResult =
  | { ok: true; promoted: PromotedBooking[] }
  | { ok: false; error: string };

/**
 * Cancel a booking, then backfill the vacancy it left from the waitlist.
 *
 * The cancel itself runs under the caller's own RLS session (member
 * self-update or staff-all policy); the promotion runs through
 * `promoteFromWaitlist`, which explains the admin-context and concurrency
 * reasoning.
 *
 * Promotion is attempted after ANY successful cancellation, not only after a
 * confirmed one. Cancelling a waitlist place does not itself free a spot, so in
 * that case the capacity check inside `promoteFromWaitlist` almost always finds
 * nothing to do and returns an empty list — but if a booking race ever left the
 * class under capacity with members still waiting, this repairs it instead of
 * silently preserving the gap.
 *
 * Notifying the promoted members is the CALLER's job: this module is DB-only
 * and must not pull the email stack into every importer. Callers pass the
 * returned rows to `notifyWaitlistPromotions` (lib/notifications.ts) and then
 * `markPromotionNotified`.
 */
export async function cancelBooking(
  identity: Identity,
  bookingId: string,
): Promise<CancelResult> {
  const cancelled = await withTenantContext(identity, async (c) => {
    const { rows } = await c.query<{ id: string; class_id: string; status: BookingStatus }>(
      `update class_bookings set status = 'cancelled', cancelled_at = now()
        where id = $1 and status in ('booked', 'waitlisted')
        returning id, class_id, status`,
      [bookingId],
    );
    return rows[0] ?? null;
  });

  if (!cancelled) return { ok: false, error: "Booking not found or already cancelled." };

  const promoted = await promoteFromWaitlist(identity.tenantId, cancelled.class_id);
  return { ok: true, promoted };
}
