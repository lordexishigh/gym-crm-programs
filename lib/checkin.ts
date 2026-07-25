import type { PoolClient } from "pg";
import QRCode from "qrcode";
import { withTenantContext, type Identity } from "@/lib/db";

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

export type CheckInResult =
  | { ok: true; memberId: string; memberName: string }
  | { ok: false; error: string };

async function recordCheckIn(
  c: PoolClient,
  tenantId: string,
  member: { id: string; full_name: string } | undefined,
  method: "pin" | "qr",
): Promise<CheckInResult> {
  if (!member) {
    return {
      ok: false,
      error: method === "pin" ? "No member with that PIN." : "QR code not recognised.",
    };
  }
  await c.query(
    `insert into check_ins (tenant_id, member_id, method) values ($1, $2, $3)`,
    [tenantId, member.id, method],
  );
  return { ok: true, memberId: member.id, memberName: member.full_name };
}

/** Look up a member by PIN (within the staff session's own tenant) and log a check-in. */
export async function checkInByPin(identity: Identity, pin: string): Promise<CheckInResult> {
  return withTenantContext(identity, async (c) => {
    const member = (
      await c.query<{ id: string; full_name: string }>(
        "select id, full_name from member where pin_code = $1",
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
      await c.query<{ id: string; full_name: string }>(
        "select id, full_name from member where qr_token = $1",
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
};

/** Today's check-ins for the staff kiosk feed (most recent first). */
export async function todaysCheckIns(identity: Identity): Promise<CheckInLogRow[]> {
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<CheckInLogRow>(
      `select ci.id, ci.member_id, m.full_name as member_name, ci.method, ci.checked_in_at
         from check_ins ci
         join member m on m.id = ci.member_id
        where ci.checked_in_at >= date_trunc('day', now())
        order by ci.checked_in_at desc
        limit 50`,
    );
    return rows;
  });
}
