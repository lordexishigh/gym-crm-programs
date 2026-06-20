"use client";

import { useActionState } from "react";
import {
  sendInviteAction,
  revokeInviteAction,
  type InviteState,
} from "./actions";

/**
 * Invite control on the member detail page (mvp-member-management-003,
 * alpha-invite-lifecycle-002).
 *
 * Send/resend is disabled when the member has no email (an invite needs a
 * deliverable address). A still-`pending` invite can be revoked, invalidating
 * its token immediately. `lastInvite.status` is the EFFECTIVE status (a
 * past-expiry pending invite already reads as "expired"). Each action surfaces
 * its own inline result.
 */
export function InvitePanel({
  memberId,
  hasEmail,
  alreadyActive,
  lastInvite,
}: {
  memberId: string;
  hasEmail: boolean;
  alreadyActive: boolean;
  lastInvite?: { id: string; status: string; expiresAt: string | null } | null;
}) {
  const [sendState, sendAction, sending] = useActionState<InviteState, FormData>(
    sendInviteAction,
    {},
  );
  const [revokeState, revokeAction, revoking] = useActionState<
    InviteState,
    FormData
  >(revokeInviteAction, {});

  const canRevoke = !alreadyActive && lastInvite?.status === "pending";

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-slate-900">Portal access</h2>
        <p className="text-sm text-slate-600">
          {alreadyActive
            ? "This member has set up their portal account."
            : "Send an invite so this member can set a password and view their programs."}
        </p>
      </div>

      {lastInvite && !alreadyActive ? (
        <p className="text-xs text-slate-500">
          Last invite: {lastInvite.status}
          {lastInvite.expiresAt
            ? ` · expires ${new Date(lastInvite.expiresAt).toLocaleDateString()}`
            : ""}
        </p>
      ) : null}

      {!alreadyActive ? (
        <div className="flex flex-wrap items-center gap-2">
          <form action={sendAction}>
            <input type="hidden" name="memberId" value={memberId} />
            <button
              type="submit"
              disabled={sending || !hasEmail}
              className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-dark disabled:opacity-60"
            >
              {sending
                ? "Sending…"
                : lastInvite?.status === "pending"
                  ? "Resend invite"
                  : "Send invite"}
            </button>
          </form>

          {canRevoke ? (
            <form action={revokeAction}>
              <input type="hidden" name="inviteId" value={lastInvite.id} />
              <input type="hidden" name="memberId" value={memberId} />
              <button
                type="submit"
                disabled={revoking}
                className="inline-flex items-center justify-center rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-60"
              >
                {revoking ? "Revoking…" : "Revoke invite"}
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {!hasEmail && !alreadyActive ? (
        <p className="text-xs text-amber-700">
          Add an email address above before sending an invite.
        </p>
      ) : null}

      {sendState.error ? (
        <p role="alert" className="text-sm text-red-600">
          {sendState.error}
        </p>
      ) : null}
      {sendState.success ? (
        <p className="text-sm text-emerald-700">{sendState.success}</p>
      ) : null}
      {revokeState.error ? (
        <p role="alert" className="text-sm text-red-600">
          {revokeState.error}
        </p>
      ) : null}
      {revokeState.success ? (
        <p className="text-sm text-emerald-700">{revokeState.success}</p>
      ) : null}
    </section>
  );
}
