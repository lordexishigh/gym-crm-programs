"use client";

import { useActionState } from "react";
import { sendInviteAction, type InviteState } from "./actions";

/**
 * Invite control on the member detail page (mvp-member-management-003).
 *
 * Disabled when the member has no email (an invite needs a deliverable
 * address). Surfaces the action's success/error result inline.
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
  lastInvite?: { status: string; expiresAt: string | null } | null;
}) {
  const [state, formAction, pending] = useActionState<InviteState, FormData>(
    sendInviteAction,
    {},
  );

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
        <form action={formAction}>
          <input type="hidden" name="memberId" value={memberId} />
          <button
            type="submit"
            disabled={pending || !hasEmail}
            className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-dark disabled:opacity-60"
          >
            {pending
              ? "Sending…"
              : lastInvite?.status === "pending"
                ? "Resend invite"
                : "Send invite"}
          </button>
        </form>
      ) : null}

      {!hasEmail && !alreadyActive ? (
        <p className="text-xs text-amber-700">
          Add an email address above before sending an invite.
        </p>
      ) : null}

      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="text-sm text-emerald-700">{state.success}</p>
      ) : null}
    </section>
  );
}
