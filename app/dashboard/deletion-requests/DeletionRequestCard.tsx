"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type { PendingDeletionRequestRow } from "@/lib/gdpr/deletion-requests";
import {
  confirmDeletionRequestAction,
  declineDeletionRequestAction,
  type DecisionState,
} from "./actions";

/** Whole days since `iso`, for the statutory-clock hint. */
function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/**
 * One pending erasure request, with its two decisions (beta-gdpr-002).
 *
 * Both are behind an explicit second step for opposite reasons: confirming is
 * irreversible, and declining needs the reason the member will be shown. Neither
 * is a one-tap action on a list.
 *
 * The age is shown against the one-month statutory deadline (GDPR Art. 12(3)),
 * because "requested 3 days ago" and "requested 26 days ago" are the same row
 * with very different urgency, and a date alone makes the reader do that
 * arithmetic themselves.
 */
export function DeletionRequestCard({
  request,
}: {
  request: PendingDeletionRequestRow;
}) {
  const [mode, setMode] = useState<"idle" | "confirm" | "decline">("idle");
  const [confirmState, confirmAction, confirming] = useActionState<
    DecisionState,
    FormData
  >(confirmDeletionRequestAction, {});
  const [declineState, declineAction, declining] = useActionState<
    DecisionState,
    FormData
  >(declineDeletionRequestAction, {});

  const age = daysSince(request.requested_at);
  const overdue = age >= 30;
  const busy = confirming || declining;
  const message = confirmState.success ?? declineState.success;
  const error = confirmState.error ?? declineState.error;

  // Once decided, the row is gone from the server-rendered queue on the next
  // load; until then show the outcome rather than the controls that produced it.
  if (message) {
    return (
      <li className="rounded-2xl border border-slate-200 bg-white p-5">
        <p className="text-sm font-medium text-emerald-700">{message}</p>
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Link
            href={`/dashboard/members/${request.member_id}`}
            className="truncate font-semibold text-slate-900 underline-offset-2 hover:underline"
          >
            {request.member_name}
          </Link>
          <span className="truncate text-sm text-slate-500">
            {request.member_email ?? "No email on file"}
          </span>
        </div>
        <span
          className={
            overdue
              ? "shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700"
              : "shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
          }
        >
          {age === 0 ? "Requested today" : `${age} day${age === 1 ? "" : "s"} ago`}
          {overdue ? " · overdue" : ""}
        </span>
      </div>

      {request.reason ? (
        <blockquote className="whitespace-pre-wrap border-l-2 border-slate-200 pl-3 text-sm text-slate-600">
          {request.reason}
        </blockquote>
      ) : (
        <p className="text-sm text-slate-500">No reason given.</p>
      )}

      {mode === "idle" ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setMode("confirm")}
            className="inline-flex items-center justify-center rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2"
          >
            Confirm erasure
          </button>
          <button
            type="button"
            onClick={() => setMode("decline")}
            className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
          >
            Decline
          </button>
        </div>
      ) : mode === "confirm" ? (
        <form action={confirmAction} className="flex flex-col gap-3">
          <input type="hidden" name="requestId" value={request.id} />
          <p className="text-sm text-red-700">
            This permanently anonymises {request.member_name}&rsquo;s personal
            data, revokes their portal access and emails them to confirm. It
            cannot be undone.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center justify-center rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:opacity-60"
            >
              {confirming ? "Erasing…" : "Yes, erase their data"}
            </button>
            <CancelButton onClick={() => setMode("idle")} disabled={busy} />
          </div>
        </form>
      ) : (
        <form action={declineAction} className="flex flex-col gap-3">
          <input type="hidden" name="requestId" value={request.id} />
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Why can this not be actioned?
            <textarea
              name="note"
              rows={3}
              required
              maxLength={1000}
              placeholder="e.g. We must keep your accident report for seven years under Cyprus law."
              className="rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            />
            <span className="text-xs font-normal text-slate-500">
              The member sees this in their portal.
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:opacity-60"
            >
              {declining ? "Saving…" : "Decline request"}
            </button>
            <CancelButton onClick={() => setMode("idle")} disabled={busy} />
          </div>
        </form>
      )}

      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function CancelButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:opacity-60"
    >
      Cancel
    </button>
  );
}
