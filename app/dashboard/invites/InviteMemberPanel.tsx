"use client";

import { useActionState } from "react";
import Link from "next/link";
import { sendInviteAction, type InviteState } from "../members/actions";
import { InviteLinkNotice } from "../InviteLinkNotice";

/** A member who can still be invited: has an email, has no portal account yet. */
export type InvitableMember = {
  id: string;
  full_name: string;
  email: string;
  /** True when a still-valid invite is already outstanding for them. */
  pending: boolean;
};

/**
 * "Invite a member" — the primary entry point for issuing a portal invite.
 *
 * WHY IT IS HERE. Sending an invite was previously reachable only from an
 * individual member's detail page, so nothing on the dashboard, the roster, or
 * this page — the one actually called "Invites" — offered any way to start the
 * flow. A staff member had to already know to open a member, scroll to a panel
 * and press a button there; a review crawl of the dashboard found no invite
 * entry point at all, which is the honest reading of what was on screen. The
 * per-member panel remains (it is the right place when you are already looking
 * at that member); this makes the same action reachable from the page named for
 * it, which is where someone looks first.
 *
 * It is a picker rather than a free-text email field on purpose: an invite is
 * bound to an existing member row (`invite.member_id`), so inviting someone who
 * is not on the roster yet is a member-creation task, not an invite task. The
 * empty state says exactly that and links to the place that does it.
 */
export function InviteMemberPanel({
  members,
  emailConfigured,
}: {
  members: InvitableMember[];
  emailConfigured: boolean;
}) {
  const [state, formAction, sending] = useActionState<InviteState, FormData>(
    sendInviteAction,
    {},
  );

  return (
    <section
      aria-labelledby="invite-member-heading"
      className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-5"
    >
      <div className="flex flex-col gap-1">
        <h2
          id="invite-member-heading"
          className="text-base font-semibold text-slate-900"
        >
          Invite a member
        </h2>
        <p className="text-sm text-slate-600">
          Send a member a link to set their password and open their training
          programs on the portal.
        </p>
      </div>

      {members.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
          Everyone on your roster with an email address already has portal
          access.{" "}
          <Link
            href="/dashboard/members/new"
            className="font-medium text-brand hover:underline"
          >
            Add a member
          </Link>{" "}
          to invite someone new.
        </p>
      ) : (
        <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-slate-700">
            Member
            <select
              name="memberId"
              required
              defaultValue=""
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 outline-none transition focus:border-brand focus-visible:ring-1 focus-visible:ring-brand"
            >
              <option value="" disabled>
                Choose a member…
              </option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name} — {m.email}
                  {m.pending ? " (invite pending)" : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={sending}
            className="inline-flex shrink-0 items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:opacity-60"
          >
            {sending ? "Sending…" : "Send invite"}
          </button>
        </form>
      )}

      {/* Told BEFORE pressing the button, not after: on a deployment with no
          mail provider the invite still works, but it is delivered by copying
          the link rather than by email, and that changes what staff do next. */}
      {!emailConfigured && members.length > 0 ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Email delivery is not configured on this deployment, so the invite
          link will be shown here for you to share directly.
        </p>
      ) : null}

      <InviteLinkNotice state={state} />
    </section>
  );
}
