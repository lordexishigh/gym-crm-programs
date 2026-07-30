"use client";

import { useActionState } from "react";
import {
  sendInviteAction,
  revokeInviteAction,
  type InviteState,
} from "../members/actions";
import { InviteLinkNotice } from "../InviteLinkNotice";

/**
 * Resend / revoke controls for a single invite row (alpha-invite-lifecycle-002).
 *
 * Resend reuses `sendInviteAction` (it issues a fresh token + email and
 * supersedes the old pending invite). Revoke flips the row to `revoked`,
 * invalidating its token immediately. Each action surfaces its own inline
 * result so feedback maps to the button the staff member pressed.
 */
export function InviteRowActions({
  inviteId,
  memberId,
  canResend,
  canRevoke,
}: {
  inviteId: string;
  memberId: string | null;
  canResend: boolean;
  canRevoke: boolean;
}) {
  const [resend, resendAction, resending] = useActionState<InviteState, FormData>(
    sendInviteAction,
    {},
  );
  const [revoke, revokeAction, revoking] = useActionState<InviteState, FormData>(
    revokeInviteAction,
    {},
  );

  // No member (orphaned invite) means there's nothing to resend to.
  const showResend = canResend && Boolean(memberId);

  if (!showResend && !canRevoke) return null;

  // Revoke has only ever had a one-line result; resend now also carries the
  // onboarding link (and a warning when its email did not go out), so it is
  // rendered by the shared notice instead.
  const revokeMsg = revoke.error ?? revoke.success;

  return (
    <div className="flex w-full flex-col items-stretch gap-1 sm:w-auto sm:max-w-md sm:items-end">
      <div className="flex items-center gap-2 sm:justify-end">
        {showResend ? (
          <form action={resendAction}>
            <input type="hidden" name="memberId" value={memberId ?? ""} />
            <button
              type="submit"
              disabled={resending}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
            >
              {resending ? "Resending…" : "Resend"}
            </button>
          </form>
        ) : null}

        {canRevoke ? (
          <form action={revokeAction}>
            <input type="hidden" name="inviteId" value={inviteId} />
            <input type="hidden" name="memberId" value={memberId ?? ""} />
            <button
              type="submit"
              disabled={revoking}
              className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-60"
            >
              {revoking ? "Revoking…" : "Revoke"}
            </button>
          </form>
        ) : null}
      </div>

      {revokeMsg ? (
        <p
          role={revoke.error ? "alert" : undefined}
          className={`text-xs ${revoke.error ? "text-red-600" : "text-emerald-700"}`}
        >
          {revokeMsg}
        </p>
      ) : null}

      <InviteLinkNotice state={resend} />
    </div>
  );
}
