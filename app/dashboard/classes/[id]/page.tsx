import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth/session";
import { classRoster } from "@/lib/classes";
import { staffCancelBookingAction } from "../actions";
import { PromoteWaitlistButton } from "../PromoteWaitlistButton";

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

  // The manual promote control only makes sense when there is both a free spot
  // and someone waiting for it — and never for a class that already ran.
  const openSpots = Math.max(cls.capacity - booked.length, 0);
  const canPromote =
    openSpots > 0 && waitlisted.length > 0 && new Date(cls.starts_at).getTime() >= Date.now();

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

      {canPromote ? (
        <PromoteWaitlistButton
          classId={cls.id}
          openSpots={openSpots}
          waitlistCount={waitlisted.length}
        />
      ) : null}

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
        <RosterList
          bookings={waitlisted}
          empty="No one is waitlisted."
          note="Cancelling a booked spot above promotes the longest-waiting member here automatically and emails them."
        />
      </section>
    </div>
  );
}

function RosterList({
  bookings,
  empty,
  note,
}: {
  bookings: {
    id: string;
    member_name: string;
    booked_at: string;
    promoted_at: string | null;
  }[];
  empty: string;
  note?: string;
}) {
  if (bookings.length === 0) {
    return <p className="text-sm text-slate-500">{empty}</p>;
  }
  return (
    <>
      <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
        {bookings.map((b) => (
          <li key={b.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="font-medium text-slate-900">{b.member_name}</span>
              {/*
               * Makes auto-promotion visible to the front desk: this seat was
               * filled from the waitlist, not booked at the counter.
               */}
              {b.promoted_at ? (
                <span
                  className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand-dark"
                  title={`Promoted from the waitlist on ${new Date(b.promoted_at).toLocaleString(
                    "en-GB",
                    { dateStyle: "medium", timeStyle: "short" },
                  )}`}
                >
                  From waitlist
                </span>
              ) : null}
            </span>
            <form action={staffCancelBookingAction}>
              <input type="hidden" name="bookingId" value={b.id} />
              <button
                type="submit"
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
              >
                Cancel
              </button>
            </form>
          </li>
        ))}
      </ul>
      {note ? <p className="text-xs text-slate-500">{note}</p> : null}
    </>
  );
}
