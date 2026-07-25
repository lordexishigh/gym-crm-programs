import { requireStaff } from "@/lib/auth/session";
import { todaysCheckIns } from "@/lib/checkin";
import { CheckinForm } from "./CheckinForm";

export const dynamic = "force-dynamic";

/** Front-desk check-in kiosk (market gap #5): PIN/QR entry + today's feed. */
export default async function CheckinPage() {
  const session = await requireStaff();
  const checkIns = await todaysCheckIns(session.identity);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Check-in</h1>
        <p className="text-sm text-slate-600">
          Scan a member's QR code or type their PIN to record attendance.
        </p>
      </div>

      <div className="mx-auto w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6">
        <CheckinForm />
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-slate-900">Today</h2>
        {checkIns.length === 0 ? (
          <p className="text-sm text-slate-500">No check-ins yet today.</p>
        ) : (
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
            {checkIns.map((ci) => (
              <li
                key={ci.id}
                className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <span className="font-medium text-slate-900">{ci.member_name}</span>
                <span className="text-slate-500">
                  {new Date(ci.checked_in_at).toLocaleTimeString("en-GB", {
                    timeStyle: "short",
                  })}{" "}
                  · {ci.method.toUpperCase()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
