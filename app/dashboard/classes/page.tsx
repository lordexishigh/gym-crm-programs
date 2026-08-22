import Link from "next/link";
import { requireCapability } from "@/lib/auth/session";
import { listUpcomingClasses } from "@/lib/classes";
import { ScheduleClassButton } from "./ScheduleClassButton";

export const dynamic = "force-dynamic";

/**
 * Staff class calendar (market gap #4): schedule classes and see live
 * booked/waitlisted counts. Any staff member can manage the schedule.
 */
export default async function ClassesPage() {
  const session = await requireCapability("classes.read");
  const classes = await listUpcomingClasses(session.identity);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold">Classes</h1>
          <p className="text-sm text-slate-600">
            Schedule sessions and track capacity. Members book from the portal.
          </p>
        </div>
        <ScheduleClassButton />
      </div>

      {classes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          No upcoming classes yet. Use “Schedule a class” to add your first.
        </div>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {classes.map((cl) => {
            const full = cl.booked_count >= cl.capacity;
            return (
              <li key={cl.id}>
                <Link
                  href={`/dashboard/classes/${cl.id}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 transition hover:bg-slate-50"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium text-slate-900">{cl.name}</span>
                    <span className="truncate text-sm text-slate-500">
                      {new Date(cl.starts_at).toLocaleString("en-GB", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}{" "}
                      · {cl.duration_minutes} min
                      {cl.instructor_name ? ` · ${cl.instructor_name}` : ""}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={
                        full
                          ? "rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
                          : "rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"
                      }
                    >
                      {cl.booked_count}/{cl.capacity} booked
                    </span>
                    {cl.waitlisted_count > 0 ? (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                        {cl.waitlisted_count} waitlisted
                      </span>
                    ) : null}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
