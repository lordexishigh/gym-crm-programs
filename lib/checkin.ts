import type { PoolClient } from "pg";
import QRCode from "qrcode";
import { withTenantContext, type Identity } from "@/lib/db";
import { memberAvatarSrc } from "@/lib/member-photo";

/**
 * QR/PIN check-in (market gap #5): a staff-side kiosk records attendance in
 * under 3 seconds by PIN entry or a scanned QR token — no member write path
 * exists (see the `check_ins` RLS policies in 0016_checkin.sql): a member can
 * never insert their own attendance row, only a staff session can, so
 * check-in always means someone at the front desk actually saw the member.
 */

const PIN_LENGTH = 6;

function randomPin(): string {
  const n = Math.floor(Math.random() * 10 ** PIN_LENGTH);
  return n.toString().padStart(PIN_LENGTH, "0");
}

/**
 * Assign a fresh, tenant-unique PIN to a member, retrying on collision.
 * Checks uniqueness with a SELECT rather than relying on the DB constraint to
 * reject a duplicate — catching a unique-violation would poison the
 * surrounding transaction (Postgres aborts a transaction on any statement
 * error until rollback), which would also undo the member creation/update
 * this is usually called alongside. The 1-in-a-million PIN space makes the
 * check-then-write race negligible at gym-membership scale.
 */
export async function generateUniquePinCode(
  c: PoolClient,
  tenantId: string,
  memberId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const pin = randomPin();
    const { rows } = await c.query(
      "select 1 from member where tenant_id = $1 and pin_code = $2",
      [tenantId, pin],
    );
    if (rows.length === 0) {
      await c.query("update member set pin_code = $2, updated_at = now() where id = $1", [
        memberId,
        pin,
      ]);
      return pin;
    }
  }
  throw new Error("Could not generate a unique PIN code after several attempts.");
}

/**
 * Assign PINs to many members at once (bulk CSV import).
 *
 * `generateUniquePinCode` costs two round-trips per member; at import scale
 * (up to 1000 rows) that is thousands of statements inside one transaction,
 * which would blow the pool's `statement_timeout` budget and leave the whole
 * import rolled back. Instead: read the tenant's taken PINs once, allocate
 * against an in-memory set, and write them all in a single UPDATE ... FROM.
 *
 * Same safety property as the single-member path — uniqueness is checked before
 * writing, never by catching a unique-violation, because an error would abort
 * the surrounding transaction and undo the member inserts themselves.
 */
export async function assignPinCodes(
  c: PoolClient,
  tenantId: string,
  memberIds: string[],
): Promise<void> {
  if (memberIds.length === 0) return;

  const taken = new Set(
    (
      await c.query<{ pin_code: string }>(
        "select pin_code from member where tenant_id = $1 and pin_code is not null",
        [tenantId],
      )
    ).rows.map((r) => r.pin_code),
  );

  const params: string[] = [];
  const tuples: string[] = [];
  for (const memberId of memberIds) {
    let pin: string | null = null;
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = randomPin();
      if (!taken.has(candidate)) {
        taken.add(candidate);
        pin = candidate;
        break;
      }
    }
    if (!pin) {
      throw new Error("Could not generate unique PIN codes for the imported members.");
    }
    tuples.push(`($${params.length + 1}::uuid, $${params.length + 2}::text)`);
    params.push(memberId, pin);
  }

  await c.query(
    `update member m
        set pin_code = v.pin, updated_at = now()
       from (values ${tuples.join(", ")}) as v(id, pin)
      where m.id = v.id`,
    params,
  );
}

/**
 * How long an un-closed visit still counts as "in the building".
 *
 * Check-out is a human action and humans forget it, so occupancy cannot simply
 * be "every row with a null `checked_out_at`" — one forgotten scan would inflate
 * the count forever and the number on the dashboard would quietly become
 * fiction. A visit that has not been closed within this window ages out of the
 * live count instead.
 *
 * Its `checked_out_at` is deliberately LEFT null rather than backfilled with a
 * guess: we know they are no longer here, we do not know when they left, and
 * writing a made-up departure time would corrupt any session-length reporting
 * built on this column later. Null means "unknown departure", which is true.
 */
export const STALE_VISIT_HOURS = 6;

/**
 * The wall-clock timezone a gym's "day" is measured in.
 *
 * `date_trunc('day', now())` truncates in the DATABASE's timezone, which is UTC
 * on this deployment. Cyprus (the market this serves) is UTC+2/+3, so a bare
 * truncation puts the day boundary at 02:00–03:00 local: a member who checked in
 * at 01:00 local dropped straight out of the "Today" feed while it was still the
 * same day to everyone in the building. Truncating the LOCAL day and converting
 * back with `AT TIME ZONE` makes "today" mean the day the front desk is having,
 * and stays correct across the EEST/EET change because Postgres resolves the
 * offset per timestamp rather than applying a fixed one.
 *
 * Env-overridable for a deployment outside Cyprus. A per-GYM timezone would be
 * the fully correct answer for a multi-tenant product and is deliberately not
 * built here — it needs a column and a settings UI, and every tenant today is in
 * one timezone. scripts/seed.mjs hardcodes the same zone for the same reason; it
 * is a .mjs script and cannot import this module.
 */
export const GYM_TIME_ZONE = process.env.GYM_TIME_ZONE?.trim() || "Europe/Nicosia";

export type CheckInResult =
  | {
      ok: true;
      /** Which half of the visit this scan recorded. */
      direction: "in" | "out";
      memberId: string;
      memberName: string;
      /**
       * The member's avatar URL, or null when they have no photo. A PIN or a
       * scanned token proves possession of a code, not identity — showing the
       * face the code belongs to is what lets whoever is on the desk confirm the
       * person in front of them is the person checking in. This is the placement
       * the profile-photo feature exists for, so it is resolved in the SAME
       * query as the lookup rather than costing a second round-trip per scan.
       */
      avatarSrc: string | null;
    }
  | { ok: false; error: string };

/** The member columns every check-in lookup needs (profile + avatar source). */
const CHECKIN_MEMBER_COLUMNS = `m.id, m.full_name, m.photo_url,
                                mp.updated_at as photo_updated_at
                           from member m
                           left join member_photo mp on mp.member_id = m.id`;

type CheckInMemberRow = {
  id: string;
  full_name: string;
  photo_url: string | null;
  photo_updated_at: Date | string | null;
};

/**
 * Record one scan as either an arrival or a departure.
 *
 * The kiosk has ONE input, so the same PIN/QR has to mean both — "scan in, scan
 * out" is how a turnstile behaves and is what the desk expects. The direction
 * is derived from state rather than from a mode the operator has to select,
 * because a mode toggle at a front desk is a thing people forget to flip, and
 * getting it wrong writes a wrong row.
 *
 * The close is a conditional UPDATE, not a read-then-write: `where
 * checked_out_at is null` makes it idempotent under a double scan, and the
 * `returning` tells us whether it actually closed anything. Two people scanning
 * the same code at once therefore produce one check-out, not two.
 */
async function recordCheckIn(
  c: PoolClient,
  tenantId: string,
  member: CheckInMemberRow | undefined,
  method: "pin" | "qr",
): Promise<CheckInResult> {
  if (!member) {
    return {
      ok: false,
      error: method === "pin" ? "No member with that PIN." : "QR code not recognised.",
    };
  }

  const closed = await c.query(
    `update check_ins
        set checked_out_at = now()
      where member_id = $1
        and checked_out_at is null
        and checked_in_at > now() - ($2 || ' hours')::interval
      returning id`,
    [member.id, String(STALE_VISIT_HOURS)],
  );

  // Nothing open (or only a stale visit past the window) → this is an arrival.
  if (closed.rowCount === 0) {
    await c.query(
      `insert into check_ins (tenant_id, member_id, method) values ($1, $2, $3)`,
      [tenantId, member.id, method],
    );
  }

  return {
    ok: true,
    direction: closed.rowCount === 0 ? "in" : "out",
    memberId: member.id,
    memberName: member.full_name,
    avatarSrc: memberAvatarSrc(member),
  };
}

/** Look up a member by PIN (within the staff session's own tenant) and log a check-in. */
export async function checkInByPin(identity: Identity, pin: string): Promise<CheckInResult> {
  return withTenantContext(identity, async (c) => {
    const member = (
      await c.query<CheckInMemberRow>(
        `select ${CHECKIN_MEMBER_COLUMNS} where m.pin_code = $1`,
        [pin],
      )
    ).rows[0];
    return recordCheckIn(c, identity.tenantId, member, "pin");
  });
}

/** Look up a member by their scanned QR token and log a check-in. RLS keeps this tenant-scoped. */
export async function checkInByQrToken(
  identity: Identity,
  qrToken: string,
): Promise<CheckInResult> {
  return withTenantContext(identity, async (c) => {
    const member = (
      await c.query<CheckInMemberRow>(
        `select ${CHECKIN_MEMBER_COLUMNS} where m.qr_token = $1`,
        [qrToken],
      )
    ).rows[0];
    return recordCheckIn(c, identity.tenantId, member, "qr");
  });
}

export type OwnCheckInCode = { pinCode: string | null; qrToken: string };

/** The signed-in member's own PIN + QR token, for the portal "show at the desk" card. */
export async function ownCheckInCode(
  identity: Identity,
  memberId: string,
): Promise<OwnCheckInCode | null> {
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<{ pin_code: string | null; qr_token: string }>(
      "select pin_code, qr_token from member where id = $1",
      [memberId],
    );
    const row = rows[0];
    return row ? { pinCode: row.pin_code, qrToken: row.qr_token } : null;
  });
}

/** Render a QR token as a scannable PNG data URI, for the portal check-in card. */
export async function checkInQrDataUrl(qrToken: string): Promise<string> {
  return QRCode.toDataURL(qrToken, { margin: 1, width: 240 });
}

export type CheckInLogRow = {
  id: string;
  member_id: string;
  member_name: string;
  method: "pin" | "qr";
  checked_in_at: string;
  /** Null while the member is still in the building (or never checked out). */
  checked_out_at: string | null;
  /** Whether this visit still counts toward live occupancy (see STALE_VISIT_HOURS). */
  is_present: boolean;
};

/**
 * Today's check-ins for the staff kiosk feed (most recent first).
 *
 * "Today" is the gym's LOCAL day (see GYM_TIME_ZONE), not the database's UTC
 * day — otherwise the feed rolls over mid-morning-shift rather than at midnight.
 */
export async function todaysCheckIns(identity: Identity): Promise<CheckInLogRow[]> {
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<CheckInLogRow>(
      `select ci.id, ci.member_id, m.full_name as member_name, ci.method,
              ci.checked_in_at, ci.checked_out_at,
              (ci.checked_out_at is null
               and ci.checked_in_at > now() - ($1 || ' hours')::interval) as is_present
         from check_ins ci
         join member m on m.id = ci.member_id
        where ci.checked_in_at >= date_trunc('day', now() at time zone $2::text)
                                    at time zone $2::text
          -- An erased member (beta-gdpr-002) drops off the desk feed: erasure
          -- also revokes their PIN/QR so they cannot appear here again, but a
          -- visit recorded EARLIER today would otherwise still be on screen
          -- under the "Erased member" tombstone.
          and m.erased_at is null
        order by ci.checked_in_at desc
        limit 50`,
      [String(STALE_VISIT_HOURS), GYM_TIME_ZONE],
    );
    return rows;
  });
}

/**
 * How many members are in the building right now (feedback-2026-08: "showcase
 * live checked in number of members in the dashboard").
 *
 * Counts DISTINCT members, not rows: a member with a stale un-closed visit from
 * this morning who scans in again this afternoon has two open rows, and the
 * count of bodies in the room is still one.
 *
 * Deliberately NOT bounded to a calendar day — the rolling window is the only
 * bound. Occupancy answers "who is in the building", and someone who arrived at
 * 23:50 is still in the building at 00:10; a day boundary would drop them from
 * the count at midnight while they were standing in the room, and would break a
 * 24-hour gym outright. (The "Today" FEED is a different question and is
 * correctly anchored to the local day — see `todaysCheckIns`.)
 */
export async function currentOccupancy(identity: Identity): Promise<number> {
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<{ count: string }>(
      `select count(distinct member_id) as count
         from check_ins
        where checked_out_at is null
          and checked_in_at > now() - ($1 || ' hours')::interval`,
      [String(STALE_VISIT_HOURS)],
    );
    return Number(rows[0]?.count ?? 0);
  });
}
