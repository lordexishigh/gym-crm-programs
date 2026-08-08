import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { checkInByPin, checkInByQrToken } from "@/lib/checkin";
import { reportHandledError } from "@/lib/observability/monitoring";

/**
 * Check-in API (market gap #5): a JSON endpoint for kiosk hardware (a
 * scanner/device integration) that can't drive the dashboard form directly.
 * Requires a staff session cookie — unlike the dashboard kiosk page this
 * returns JSON rather than redirecting, since a redirect response would be
 * meaningless to a device client, so the auth check is inlined instead of
 * using `requireStaff` (which redirects).
 */
export const dynamic = "force-dynamic";

const PIN_RE = /^\d{6}$/;

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || session.role !== "staff") {
    return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });
  }

  let body: { pin?: unknown; qrToken?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const pin = typeof body.pin === "string" ? body.pin.trim() : "";
  const qrToken = typeof body.qrToken === "string" ? body.qrToken.trim() : "";
  if (!pin && !qrToken) {
    return NextResponse.json({ ok: false, error: "Provide a pin or qrToken." }, { status: 400 });
  }
  if (pin && !PIN_RE.test(pin)) {
    return NextResponse.json({ ok: false, error: "PIN must be 6 digits." }, { status: 400 });
  }

  try {
    const result = pin
      ? await checkInByPin(session.identity, pin)
      : await checkInByQrToken(session.identity, qrToken);

    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      memberId: result.memberId,
      memberName: result.memberName,
    });
  } catch (err) {
    await reportHandledError(err, "checkin-api", { tenantId: session.identity.tenantId });
    return NextResponse.json({ ok: false, error: "Check-in failed." }, { status: 500 });
  }
}
