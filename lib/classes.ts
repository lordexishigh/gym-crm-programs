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
};

/** A class from the member's point of view, with their own booking (if any). */
export type MemberClassView = ClassRow & {
  booking_id: string | null;
  booking_status: BookingStatus | null;
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
                cb.booked_at, cb.cancelled_at, m.full_name as member_name
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
 * Book a member into a class: confirmed if under capacity, waitlisted
 * otherwise.
 *
 * NOTE: this reads the current booked-count and then inserts in two steps
 * without a row lock on `classes` — RLS gives a member session no UPDATE
 * policy on that table (only staff can write it), and `SELECT ... FOR UPDATE`
 * requires an applicable UPDATE policy on top of SELECT, so a member-session
 * lock attempt would find no lockable row. The accepted trade-off is a small
 * race window: two members booking the last open spot in the same instant
 * could both be confirmed, over capacity by one. Acceptable for a front-desk
 * class booking (rare collision, low stakes); the one-active-booking-per-
 * member unique index still prevents a single member double-booking.
 */
export async function bookClass(
  identity: Identity,
  memberId: string,
  classId: string,
): Promise<BookResult> {
  return withTenantContext(identity, async (c) => {
    const cls = (
      await c.query<{ capacity: number }>("select capacity from classes where id = $1", [
        classId,
      ])
    ).rows[0];
    if (!cls) return { ok: false, error: "Class not found." };

    const { rows: countRows } = await c.query<{ count: string }>(
      "select count(*)::text as count from class_bookings where class_id = $1 and status = 'booked'",
      [classId],
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

export type CancelResult =
  | { ok: true; promotedMemberId: string | null }
  | { ok: false; error: string };

/**
 * Cancel a booking. If it was a confirmed ('booked') spot, promotes the
 * longest-waiting waitlisted booking for the same class to 'booked'.
 *
 * The cancel itself runs under the caller's own RLS session (member
 * self-update or staff-all policy). The promotion, though, is a write to
 * ANOTHER member's row — no RLS policy permits that for a member session, and
 * rightly so — so it runs via `withAdminContext`, the same narrowly-scoped
 * admin-path pattern used for invite acceptance. `for update skip locked`
 * ensures two concurrent cancellations for the same class each promote a
 * DIFFERENT waitlisted booking rather than racing on one row.
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

  // Only a freed CONFIRMED spot triggers a promotion — cancelling a waitlist
  // place changes nothing for anyone else.
  const wasBooked = cancelled.status === "booked";
  if (!wasBooked) return { ok: true, promotedMemberId: null };

  const promoted = await withAdminContext(async (c) => {
    const { rows } = await c.query<{ member_id: string }>(
      `update class_bookings set status = 'booked'
        where id = (
          select id from class_bookings
           where class_id = $1 and status = 'waitlisted' and tenant_id = $2
           order by booked_at asc
           for update skip locked
           limit 1
        )
        returning member_id`,
      [cancelled.class_id, identity.tenantId],
    );
    return rows[0] ?? null;
  });

  return { ok: true, promotedMemberId: promoted?.member_id ?? null };
}
