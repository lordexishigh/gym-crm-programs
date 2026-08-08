"use client";

import { useEffect, useState } from "react";
import type { InviteState } from "./members/actions";

/**
 * Shared result display for every surface that issues an invite — the member
 * detail panel, the invite-list row actions, and the "Invite a member" control
 * on /dashboard/invites.
 *
 * It exists because an invite has THREE outcomes, not two, and the third is the
 * one that used to be unreachable: the invite is valid but its email did not go
 * out (no mail provider configured, or the provider rejected the address). That
 * is a `warning`, not an `error` — the member can still be onboarded, so the
 * screen has to hand the staff member the link rather than just apologise. See
 * `sendInviteAction`, which keeps the invite row in exactly that case.
 *
 * The link is shown on success too. A member who never received the email, or
 * deleted it, is a routine support request, and "copy the link and send it to
 * them" is the whole answer.
 */
export function InviteLinkNotice({ state }: { state: InviteState }) {
  if (!state.error && !state.success && !state.warning && !state.acceptUrl) {
    return null;
  }

  return (
    <div className="flex w-full flex-col gap-2">
      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
      {state.warning ? (
        <p
          role="alert"
          className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          {state.warning}
        </p>
      ) : null}
      {state.success ? (
        <p className="text-sm text-emerald-700">{state.success}</p>
      ) : null}

      {state.acceptUrl ? <CopyableLink url={state.acceptUrl} /> : null}
    </div>
  );
}

/**
 * The onboarding link, selectable and copyable.
 *
 * `readOnly` rather than plain text so the whole URL can be selected with one
 * click on a touch device, where dragging a selection across a wrapped 80-plus
 * character link is genuinely hard. The copy button is progressive enhancement
 * on top of that: `navigator.clipboard` needs a secure context and permission,
 * so when it is unavailable or refused the input is still the working path and
 * the button says what went wrong instead of silently doing nothing.
 */
function CopyableLink({ url }: { url: string }) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");

  // Reset the confirmation so the button does not sit on "Copied" indefinitely,
  // and so a second copy of the same link visibly confirms again.
  useEffect(() => {
    if (copied === "idle") return;
    const timer = setTimeout(() => setCopied("idle"), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  // A new link supersedes the old one; drop any stale confirmation with it.
  useEffect(() => setCopied("idle"), [url]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <span className="text-xs font-medium text-slate-700">
        Onboarding link
      </span>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          readOnly
          value={url}
          aria-label="Invite onboarding link"
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-700 outline-none focus:border-brand focus-visible:ring-1 focus-visible:ring-brand"
        />
        <button
          type="button"
          onClick={copy}
          className="inline-flex shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
        >
          {copied === "done"
            ? "Copied"
            : copied === "failed"
              ? "Copy failed — select it"
              : "Copy link"}
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Single-use, and expires with the invite. Anyone with this link can set
        this member&apos;s portal password.
      </p>
      {/* Politely announce the copy result for screen readers. */}
      <span aria-live="polite" className="sr-only">
        {copied === "done"
          ? "Invite link copied to clipboard"
          : copied === "failed"
            ? "Could not copy automatically; select the link and copy it"
            : ""}
      </span>
    </div>
  );
}
