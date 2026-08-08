"use client";

import { useActionState } from "react";
import Link from "next/link";
import { reviewSuggestionAction, type ReviewFormState } from "./actions";
import type { PendingSuggestionRow } from "@/lib/suggestions";

const initialState: ReviewFormState = {};

/**
 * One suggestion, its evidence, and the two decisions a trainer can make.
 *
 * The evidence is rendered EXPANDED, not behind a disclosure. A trainer is being
 * asked to contact a member about their training on the strength of a derived
 * claim, and hiding the basis one click away optimises for a tidy list at the
 * cost of the only thing that makes the claim actionable. The observations are
 * short by construction (lib/briefs.ts writes one line each), so there is no
 * real tidiness to buy.
 *
 * "Mark as actioned" rather than "Accept": nothing is applied to any record. The
 * decision being recorded is that a human dealt with it, which is exactly what
 * the ledger needs to show later.
 */
export function SuggestionCard({
  suggestion,
}: {
  suggestion: PendingSuggestionRow;
}) {
  const [state, formAction, pending] = useActionState(
    reviewSuggestionAction,
    initialState,
  );

  const subjectHref = suggestion.member_id
    ? `/dashboard/members/${suggestion.member_id}`
    : suggestion.program_id
      ? `/dashboard/programs/${suggestion.program_id}`
      : null;
  const subjectName =
    suggestion.member_name ?? suggestion.program_name ?? "Unknown";

  return (
    <li className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={
              suggestion.strength === "strong"
                ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800"
                : "rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700"
            }
            // The badge needs its meaning attached: "weak" is not a criticism of
            // the suggestion, it is a statement about what the claim rests on.
            title={
              suggestion.strength === "strong"
                ? "Every observation below was read directly from your gym's own records."
                : "Some of the basis below was generated or came from outside your records — read it before acting."
            }
          >
            {suggestion.strength === "strong"
              ? "From your records"
              : "Needs a closer look"}
          </span>
          {subjectHref ? (
            <Link
              href={subjectHref}
              className="text-sm font-semibold text-brand underline-offset-2 hover:underline"
            >
              {subjectName}
            </Link>
          ) : (
            <span className="text-sm font-semibold text-slate-900">
              {subjectName}
            </span>
          )}
        </div>
        <p className="text-sm text-slate-800">{suggestion.headline}</p>
      </div>

      <div className="flex flex-col gap-1.5 rounded-xl bg-slate-50 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          What this is based on
        </h3>
        <ul className="flex flex-col gap-1">
          {suggestion.evidence.map((o, i) => (
            <li key={`${o.source}-${i}`} className="text-sm text-slate-700">
              {o.observed}{" "}
              <code className="text-xs text-slate-400">{o.source}</code>
            </li>
          ))}
        </ul>
      </div>

      <form action={formAction} className="flex flex-col gap-2">
        <input type="hidden" name="id" value={suggestion.id} />
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Note (optional)
          <input
            type="text"
            name="note"
            placeholder="Called her — coming back Tuesday"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            name="decision"
            value="accepted"
            disabled={pending}
            className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-dark disabled:opacity-60"
          >
            {pending ? "Saving…" : "Mark as actioned"}
          </button>
          <button
            type="submit"
            name="decision"
            value="dismissed"
            disabled={pending}
            className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 disabled:opacity-60"
          >
            Dismiss
          </button>
        </div>
        {state.error && (
          <p role="alert" className="text-sm text-red-700">
            {state.error}
          </p>
        )}
        {state.success && (
          <p role="status" className="text-sm text-emerald-700">
            {state.success}
          </p>
        )}
      </form>
    </li>
  );
}
