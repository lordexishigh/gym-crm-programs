"use client";

import { useActionState } from "react";
import {
  sendInviteAction,
  revokeInviteAction,
  type InviteState,
} from "../members/actions";

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

  const msg = resend.error ?? revoke.error ?? resend.success ?? revoke.success;
  const isError = Boolean(resend.error ?? revoke.error);

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
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

      {msg ? (
        <p
          role={isError ? "alert" : undefined}
          className={`text-xs ${isError ? "text-red-600" : "text-emerald-700"}`}
        >
          {msg}
        </p>
      ) : null}
    </div>
  );
}
