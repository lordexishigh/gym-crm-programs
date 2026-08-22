"use client";

import { useActionState, useState } from "react";
import { requestErasureAction, type ErasureRequestState } from "./actions";
import type { MemberDeletionRequestView } from "@/lib/gdpr/deletion-requests";

/**
 * "Your data" card on the member portal (beta-gdpr-002): where the data subject
 * exercises their right to erasure themselves.
 *
 * Deliberately behind a two-step confirm, and worded so the member knows what
 * they are asking for before they ask: this is irreversible, it ends their portal
 * access, and it is a REQUEST their gym reviews rather than an instant delete.
 * A member who already has a request on file sees its state instead of the form,
 * so the button cannot read as "nothing happened" and get tapped again.
 */
export function DataPrivacy({
  request,
}: {
  request: MemberDeletionRequestView | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<
    ErasureRequestState,
    FormData
  >(requestErasureAction, {});

  // The action's own success message is authoritative right after submitting
  // (the server component's `request` prop catches up on the next render).
  const filed = Boolean(state.success) || request?.status === "pending";

  return (
    <section className="mt-10 flex flex-col gap-3 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-bold text-slate-900">Your data</h2>

      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white px-4 py-4">
        {filed ? (
          <div className="flex flex-col gap-1">
            <span className="w-fit rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
              Deletion requested
            </span>
            <p className="text-sm text-slate-600">
              {state.success ??
                "Your gym is reviewing your request. You'll get an email once your data has been deleted."}
            </p>
            {request?.requested_at ? (
              <p className="text-xs text-slate-500">
                Requested{" "}
                {new Date(request.requested_at).toLocaleDateString("en-GB", {
                  dateStyle: "long",
                })}
              </p>
            ) : null}
          </div>
        ) : request?.status === "declined" ? (
          <div className="flex flex-col gap-1">
            <span className="w-fit rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
              Deletion declined
            </span>
            {/* Refusal is lawful only if the subject is told why, so the gym's
                reason is shown verbatim rather than summarised away. */}
            <p className="text-sm text-slate-600">
              {request.decision_note ??
                "Your gym could not action this request. Please contact them for details."}
            </p>
            <p className="text-xs text-slate-500">
              If your circumstances have changed, ask again below.
            </p>
            <DeletionForm
              confirming={confirming}
              setConfirming={setConfirming}
              formAction={formAction}
              pending={pending}
            />
          </div>
        ) : (
          <>
            <p className="text-sm text-slate-600">
              You can ask your gym to delete the personal data they hold about
              you. Your name, contact details, photo and any notes are removed;
              your training history is kept only in anonymised form.
            </p>
            <DeletionForm
              confirming={confirming}
              setConfirming={setConfirming}
              formAction={formAction}
              pending={pending}
            />
          </>
        )}

        {state.error ? (
          <p role="alert" className="text-sm text-red-600">
            {state.error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** The request control: a low-key button that opens an explicit confirm step. */
function DeletionForm({
  confirming,
  setConfirming,
  formAction,
  pending,
}: {
  confirming: boolean;
  setConfirming: (v: boolean) => void;
  formAction: (formData: FormData) => void;
  pending: boolean;
}) {
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="w-fit rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2"
      >
        Request deletion of my data
      </button>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <p className="text-sm text-red-700">
        This asks your gym to permanently delete your personal data. It cannot be
        undone, and you will lose access to this portal, your programs and your
        class bookings.
      </p>
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Reason (optional)
        <textarea
          name="reason"
          rows={3}
          maxLength={1000}
          placeholder="Anything you'd like your gym to know."
          className="rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center justify-center rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:opacity-60"
        >
          {pending ? "Sending…" : "Send my deletion request"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={pending}
          className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
