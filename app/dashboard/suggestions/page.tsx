import Link from "next/link";
import { requireStaff } from "@/lib/auth/session";
import { listPendingSuggestions } from "@/lib/suggestions";
import { hasCapability } from "@/lib/capabilities";
import { SuggestionCard } from "./SuggestionCard";

export const dynamic = "force-dynamic";

/**
 * The review queue: derived claims about members, waiting for a trainer.
 *
 * This is the half the roster's at-risk badge could not provide. The badge says
 * a member went quiet; this says since when, against which program, and how many
 * sessions they logged before stopping — so the trainer reaches for the phone
 * instead of opening five tabs to reconstruct it.
 *
 * Nothing here is applied automatically. Every row is a claim a human accepts or
 * dismisses, and the decision is recorded with its author (see
 * migration 0021 for why that matters for health-adjacent data under GDPR).
 */
export default async function SuggestionsPage() {
  const session = await requireStaff();
  const suggestions = await listPendingSuggestions(session.identity);

  const schedulerReady = hasCapability("scheduler");

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Needs review</h1>
        <p className="text-sm text-slate-600">
          Members worth a conversation, with the records behind each one. Nothing
          is changed until you decide.
        </p>
      </div>

      {suggestions.length === 0 ? (
        <section className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-slate-300 bg-white p-8">
          <h2 className="text-base font-semibold text-slate-900">
            Nothing to review
          </h2>
          {/* The empty state has two very different causes, and conflating them
              is how "no at-risk members" hides "the generator never ran". */}
          {schedulerReady ? (
            <p className="max-w-prose text-sm text-slate-600">
              Every member who has trained here logged a session recently. Briefs
              are generated weekly for anyone who goes quiet, so this page fills
              itself — there is nothing to set up.
            </p>
          ) : (
            <div className="flex max-w-prose flex-col gap-2">
              <p className="text-sm text-slate-600">
                This page is empty because scheduled jobs are not configured on
                this deployment, so no briefs have been generated yet. That is a
                configuration gap, not a sign that every member is engaged.
              </p>
              <p className="text-sm text-slate-600">
                Set <code className="font-mono text-xs">CRON_SECRET</code> in the
                deployment environment (see{" "}
                <code className="font-mono text-xs">.env.example</code>) to switch
                it on.
              </p>
            </div>
          )}
          <Link
            href="/dashboard/members"
            className="text-sm font-medium text-brand underline-offset-2 hover:underline"
          >
            Go to the roster
          </Link>
        </section>
      ) : (
        <ul className="flex flex-col gap-4">
          {suggestions.map((s) => (
            <SuggestionCard key={s.id} suggestion={s} />
          ))}
        </ul>
      )}
    </div>
  );
}
