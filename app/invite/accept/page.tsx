import Link from "next/link";
import { lookupInviteByToken } from "@/lib/invite-acceptance";
import { AcceptForm } from "./AcceptForm";

// Token-derived; never statically rendered or cached.
export const dynamic = "force-dynamic";

/**
 * Invite acceptance page (mvp-member-management-004). Lives OUTSIDE the
 * middleware-protected `/portal` + `/dashboard` prefixes so an unauthenticated
 * invitee can reach it. A valid token shows the password-setup form; an
 * invalid/expired/used one shows a clear message instead.
 *
 * This is the app's one DEAD-LINK SURFACE: the token arrives from an email that
 * may be weeks old, forwarded, truncated by a mail client, or simply guessed at.
 * Every one of those cases must land on this page with a readable explanation and
 * a way onward — never on the error boundary, which tells the visitor nothing
 * they can act on. `lookupInviteByToken` therefore returns a status for a
 * database that is down too (`unavailable`), so there is no path from a bad or
 * dead link to a crash.
 */
export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const invite = await lookupInviteByToken(token);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-5 py-12">
      <div className="flex flex-col gap-1 text-center">
        <Link href="/" className="text-sm font-semibold text-brand">
          Alpha CRM
        </Link>
        <h1 className="text-2xl font-bold">
          {invite.status === "valid" ? "Set up your account" : "Invite"}
        </h1>
      </div>

      {invite.status === "valid" ? (
        <>
          <p className="text-center text-sm text-slate-600">
            Hi {invite.memberName}, set a password to access your training
            programs. You&apos;ll sign in with{" "}
            <span className="font-medium text-slate-800">{invite.email}</span>.
          </p>
          <AcceptForm token={token ?? ""} />
        </>
      ) : invite.status === "unavailable" ? (
        // Our outage, not a bad link: amber (warning), not red (danger), and no
        // advice to request a replacement invite — the one they hold may be fine.
        <div className="flex flex-col gap-4">
          <p
            role="alert"
            className="rounded-lg bg-amber-500/10 px-4 py-3 text-center text-sm text-amber-300"
          >
            We couldn&apos;t check this invite link just now — that&apos;s a
            problem on our side, not with your link. Please try again in a
            moment; it has been logged.
          </p>
          {/*
            A plain anchor, not `<Link>`: this must be a full navigation so the
            Server Component re-runs the lookup. A client-side Link to the URL we
            are already on would not re-fetch, leaving "Try again" doing nothing.
            The token is carried across so the retry checks the SAME invite.
          */}
          <a
            href={`/invite/accept?token=${encodeURIComponent(token ?? "")}`}
            className="rounded-lg bg-brand px-4 py-3 text-center text-base font-medium text-white transition hover:bg-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
          >
            Try again
          </a>
          <Link
            href="/portal/login"
            className="text-center text-sm font-medium text-brand underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
          >
            Go to member sign in
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p
            role="alert"
            className="rounded-lg bg-red-50 px-4 py-3 text-center text-sm text-red-700"
          >
            {invite.status === "expired"
              ? "This invite has expired. Please ask your gym to send a new one."
              : invite.status === "used"
                ? "This invite has already been used. If that was you, sign in below."
                : "This invite link is invalid or incomplete."}
          </p>
          <Link
            href="/portal/login"
            className="text-center text-sm font-medium text-brand underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
          >
            Go to member sign in
          </Link>
        </div>
      )}
    </main>
  );
}
