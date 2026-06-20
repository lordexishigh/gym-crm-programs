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
      ) : (
        <div className="flex flex-col gap-4">
          <p className="rounded-lg bg-red-50 px-4 py-3 text-center text-sm text-red-700">
            {invite.status === "expired"
              ? "This invite has expired. Please ask your gym to send a new one."
              : invite.status === "used"
                ? "This invite has already been used. If that was you, sign in below."
                : "This invite link is invalid or incomplete."}
          </p>
          <Link
            href="/portal/login"
            className="text-center text-sm font-medium text-brand underline"
          >
            Go to member sign in
          </Link>
        </div>
      )}
    </main>
  );
}
