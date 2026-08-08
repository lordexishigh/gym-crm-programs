"use client";

import { useActionState } from "react";
import type { MemberClassView } from "../../lib/classes";
import {
  bookClassAction,
  cancelClassBookingAction,
  type BookClassState,
  type CancelBookingState,
} from "./actions";

const bookInitialState: BookClassState = {};
const cancelInitialState: CancelBookingState = {};

/**
 * "Classes" section for the member portal (market gap #4/#8): browse the
 * upcoming schedule, book a spot (or join the waitlist once full — the server
 * action decides which), and cancel an existing booking. Each row owns its own
 * action state so one row's pending/error state never blocks another's.
 */
export function ClassSchedule({ classes }: { classes: MemberClassView[] }) {
  return (
    <section className="mt-10 flex flex-col gap-3 border-t border-slate-200 pt-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-slate-900">Classes</h2>
        <p className="text-sm text-slate-600">
          Book your spot — you&apos;ll be waitlisted automatically if a class is full.
        </p>
      </div>
      {/*
       * The section renders even with nothing on the schedule. Returning null
       * here (as this did) hides a shipped feature whenever the gym has not
       * posted classes yet, so the portal looks like it has no class booking at
       * all rather than no classes THIS week — which is exactly how an
       * evaluation of this app concluded the feature was not live.
       */}
      {classes.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          No classes are scheduled right now — new sessions will show up here as
          soon as your gym posts them.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {classes.map((cl) => (
            <ClassScheduleRow key={cl.id} cl={cl} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ClassScheduleRow({ cl }: { cl: MemberClassView }) {
  const [bookState, bookFormAction, bookPending] = useActionState(
    bookClassAction,
    bookInitialState,
  );
  const [cancelState, cancelFormAction, cancelPending] = useActionState(
    cancelClassBookingAction,
    cancelInitialState,
  );

  const when = new Date(cl.starts_at).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const full = cl.booked_count >= cl.capacity;
  const isBooked = cl.booking_status === "booked" || cl.booking_status === "waitlisted";
  // Auto-promoted off the waitlist. The member is emailed when it happens, but
  // the portal must say so too — otherwise someone who checks here instead of
  // their inbox still believes they are waiting and skips the class.
  const wasPromoted = cl.booking_status === "booked" && Boolean(cl.booking_promoted_at);

  return (
    <li className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold text-slate-900">{cl.name}</span>
          <span className="truncate text-xs text-slate-500">
            {when} · {cl.duration_minutes} min
            {cl.instructor_name ? ` · ${cl.instructor_name}` : ""}
          </span>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
            full ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"
          }`}
        >
          {cl.booked_count}/{cl.capacity}
        </span>
      </div>

      {isBooked ? (
        <form action={cancelFormAction} className="flex items-center gap-2">
          <input type="hidden" name="bookingId" value={cl.booking_id ?? ""} />
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              cl.booking_status === "waitlisted"
                ? "bg-slate-100 text-slate-600"
                : "bg-brand/10 text-brand-dark"
            }`}
          >
            {cl.booking_status === "waitlisted" ? "Waitlisted" : "You're booked"}
          </span>
          {wasPromoted ? (
            <span className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand-dark">
              A spot opened up
            </span>
          ) : null}
          <button
            type="submit"
            disabled={cancelPending}
            className="ml-auto rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60"
          >
            {cancelPending ? "Cancelling…" : "Cancel"}
          </button>
        </form>
      ) : (
        <form action={bookFormAction} className="flex items-center gap-2">
          <input type="hidden" name="classId" value={cl.id} />
          <button
            type="submit"
            disabled={bookPending}
            className="ml-auto inline-flex items-center justify-center rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:opacity-60"
          >
            {bookPending ? "Booking…" : full ? "Join waitlist" : "Book"}
          </button>
        </form>
      )}

      {bookState.error ? (
        <p role="alert" className="text-xs text-red-600">
          {bookState.error}
        </p>
      ) : null}
      {bookState.success ? (
        <p role="status" className="text-xs font-medium text-brand">
          {bookState.success}
        </p>
      ) : null}
      {cancelState.error ? (
        <p role="alert" className="text-xs text-red-600">
          {cancelState.error}
        </p>
      ) : null}
      {cancelState.success ? (
        <p role="status" className="text-xs font-medium text-brand">
          {cancelState.success}
        </p>
      ) : null}
    </li>
  );
}
