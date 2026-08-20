import Link from "next/link";
import { requireStaff } from "@/lib/auth/session";
import { isEmailConfigured } from "@/lib/email/resend";
import { listPendingDeletionRequests } from "@/lib/gdpr/deletion-requests";
import { DeletionRequestCard } from "./DeletionRequestCard";

export const dynamic = "force-dynamic";

/**
 * Member erasure requests awaiting a decision (beta-gdpr-002).
 *
 * The controller's side of the right-to-erasure workflow. A member files the
 * request from their own portal ("Your data"); it lands here, oldest first,
 * because the one-month statutory deadline runs from the request date. Nothing
 * happens until a human decides — erasure is irreversible and Art. 17(3) leaves
 * the gym lawful grounds to refuse, so both outcomes are first-class.
 *
 * Gated by `requireStaff`, matching the erasure control that already lives on
 * the member detail page: any staff member who can erase a member directly can
 * also action a request to. The real boundary is RLS
 * (`member_deletion_request_staff_all`, migration 0026), which makes another
 * gym's requests invisible.
 */
export default async function DeletionRequestsPage() {
  const session = await requireStaff();
  const requests = await listPendingDeletionRequests(session.identity);

  const mailReady = isEmailConfigured();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Deletion requests</h1>
        <p className="text-sm text-slate-600">
          Members who have asked you to delete the personal data you hold about
          them. You have one month to respond.
        </p>
      </div>

      {/* A deployment with no mail provider can still erase, but cannot notify —
          and the member has to be told. Said here, before staff confirm, rather
          than only afterwards in the result message. */}
      {!mailReady && requests.length > 0 ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Email is not configured on this deployment, so confirmations cannot be
          sent automatically. You will need to tell the member yourself once
          their data is erased.
        </p>
      ) : null}

      {requests.length === 0 ? (
        <section className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-slate-300 bg-white p-8">
          <h2 className="text-base font-semibold text-slate-900">
            No requests waiting
          </h2>
          <p className="max-w-prose text-sm text-slate-600">
            Nothing to decide. When a member asks for their data to be deleted
            from their portal, the request appears here and on your overview.
          </p>
          <p className="max-w-prose text-sm text-slate-600">
            You can also erase a member directly from their profile, under
            &ldquo;Data &amp; privacy&rdquo;.
          </p>
          <Link
            href="/dashboard/members"
            className="text-sm font-medium text-brand underline-offset-2 hover:underline"
          >
            Go to the roster
          </Link>
        </section>
      ) : (
        <ul className="flex flex-col gap-4">
          {requests.map((r) => (
            <DeletionRequestCard key={r.id} request={r} />
          ))}
        </ul>
      )}
    </div>
  );
}
