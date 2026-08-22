import { requireCapability } from "@/lib/auth/session";
import { currentOccupancy, todaysCheckIns, STALE_VISIT_HOURS } from "@/lib/checkin";
import { CheckinForm } from "./CheckinForm";

export const dynamic = "force-dynamic";

/** Wall-clock time for the feed, matching the en-GB formatting used elsewhere. */
function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("en-GB", { timeStyle: "short" });
}

/** Front-desk check-in kiosk (market gap #5): PIN/QR entry + today's feed. */
export default async function CheckinPage() {
  const session = await requireCapability("checkin");
  const [checkIns, occupancy] = await Promise.all([
    todaysCheckIns(session.identity),
    currentOccupancy(session.identity),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Check-in</h1>
        <p className="text-sm text-slate-600">
          Scan a member&apos;s QR code or type their PIN. The same code checks
          them out when they leave.
        </p>
      </div>

      {/* Live occupancy — the number the desk is actually asked for. */}
      <div className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
          <svg
            width={22}
            height={22}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          </svg>
        </span>
        <span className="flex flex-col gap-0.5">
          <span className="text-3xl font-bold tabular-nums text-slate-900">
            {occupancy}
          </span>
          <span className="text-sm font-medium text-slate-700">
            In the gym right now
          </span>
          <span className="text-xs text-slate-500">
            A visit not checked out within {STALE_VISIT_HOURS} hours stops
            counting.
          </span>
        </span>
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
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium text-slate-900">
                    {ci.member_name}
                  </span>
                  {ci.is_present ? (
                    <span className="shrink-0 rounded-full bg-brand/15 px-2 py-0.5 text-xs font-medium text-brand">
                      In
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-slate-500">
                  {formatTime(ci.checked_in_at)}
                  {/* An em dash with no end time reads as "still here"; a
                      completed visit shows both ends so the desk can see how
                      long someone stayed without opening anything. */}
                  {ci.checked_out_at ? ` – ${formatTime(ci.checked_out_at)}` : " –"}
                  {" · "}
                  {ci.method.toUpperCase()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
