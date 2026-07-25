import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth/session";
import { classRoster } from "@/lib/classes";
import { staffCancelBookingAction } from "../actions";

export const dynamic = "force-dynamic";

/** Staff roster view for one class: who's booked, who's waitlisted, cancel controls. */
export default async function ClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireStaff();
  const { class: cls, bookings } = await classRoster(session.identity, id);
  if (!cls) notFound();

  const booked = bookings.filter((b) => b.status === "booked");
  const waitlisted = bookings.filter((b) => b.status === "waitlisted");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href="/dashboard/classes"
          className="text-sm font-medium text-slate-500 hover:text-slate-700"
        >
          ← Classes
        </Link>
        <h1 className="text-2xl font-bold">{cls.name}</h1>
        <p className="text-sm text-slate-600">
          {new Date(cls.starts_at).toLocaleString("en-GB", {
            dateStyle: "full",
            timeStyle: "short",
          })}{" "}
          · {cls.duration_minutes} min
          {cls.instructor_name ? ` · ${cls.instructor_name}` : ""} · capacity {cls.capacity}
        </p>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-slate-900">
          Booked ({booked.length}/{cls.capacity})
        </h2>
        <RosterList bookings={booked} empty="No one has booked yet." />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-slate-900">
          Waitlist ({waitlisted.length})
        </h2>
        <RosterList bookings={waitlisted} empty="No one is waitlisted." />
      </section>
    </div>
  );
}

function RosterList({
  bookings,
  empty,
}: {
  bookings: { id: string; member_name: string; booked_at: string }[];
  empty: string;
}) {
  if (bookings.length === 0) {
    return <p className="text-sm text-slate-500">{empty}</p>;
  }
  return (
    <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
      {bookings.map((b) => (
        <li key={b.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <span className="font-medium text-slate-900">{b.member_name}</span>
          <form action={staffCancelBookingAction}>
            <input type="hidden" name="bookingId" value={b.id} />
            <button
              type="submit"
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Cancel
            </button>
          </form>
        </li>
      ))}
    </ul>
  );
}
