import { requireMember } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Member portal home. Resolves the signed-in member's OWN row under RLS to
 * prove the session maps to a single Member + gym tenant server-side. The
 * member_self_select policy (migration 0002) restricts this to their row only.
 */
export default async function PortalHomePage() {
  const session = await requireMember();

  const member = await withTenantContext(session.identity, async (c) => {
    const { rows } = await c.query<{ full_name: string }>(
      "select full_name from member where id = $1",
      [session.identity.memberId],
    );
    return rows[0] ?? null;
  });

  const firstName = member?.full_name?.split(" ")[0] ?? "there";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Hi {firstName}</h1>
        <p className="text-sm text-slate-600">
          Your assigned training programs will appear here.
        </p>
      </div>

      <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
        No programs yet. Your trainer will assign one soon.
      </div>
    </div>
  );
}
