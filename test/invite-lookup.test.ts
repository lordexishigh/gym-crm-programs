import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression guard: a DEAD INVITE LINK must render a page, never crash.
 *
 * `/invite/accept?token=…` is the app's one surface reached by strangers holding
 * nothing but a URL — from an email that may be weeks old, forwarded, or cut
 * short by a mail client. `lookupInviteByToken` is the first thing it runs, and
 * it queries the database before it can classify the token.
 *
 * So an unset or unreachable DATABASE_URL used to throw straight out of the
 * Server Component into `app/invite/error.tsx`: the visitor got "Something went
 * wrong" with a stack-trace reference instead of the specific, actionable
 * guidance the page already has for invalid, expired and used tokens. Worse, the
 * same throw escaped `acceptInviteAction`, so submitting the password form
 * crashed rather than showing a message.
 *
 * The failure is now a status (`unavailable`) that both the page and the action
 * render — and it is deliberately DISTINCT from `invalid`, so a member holding a
 * good link is never told their link is broken and sent to their gym for a
 * replacement that would fail identically.
 *
 * `lib/db` is mocked: this suite has no Postgres, and the point is what happens
 * when there isn't one.
 */

const withAdminContext = vi.fn();

vi.mock("@/lib/db", () => ({
  withAdminContext: (fn: unknown) => withAdminContext(fn),
}));

const reportHandledError = vi.fn(
  async (_error: unknown, _source: string, _context?: unknown) => "correlation-id",
);

vi.mock("@/lib/observability/monitoring", () => ({
  reportHandledError: (error: unknown, source: string, context?: unknown) =>
    reportHandledError(error, source, context),
}));

/** Drive the mocked admin context with a query result, as `pg` would shape it. */
function respondWith(rows: unknown[]) {
  withAdminContext.mockImplementation(
    async (fn: (c: { query: () => Promise<{ rows: unknown[] }> }) => unknown) =>
      fn({ query: async () => ({ rows }) }),
  );
}

describe("lookupInviteByToken — a dead link never throws", () => {
  beforeEach(() => {
    vi.resetModules();
    withAdminContext.mockReset();
    reportHandledError.mockClear();
  });

  it("reports `unavailable` when DATABASE_URL is not set", async () => {
    // Exactly what lib/db throws on a checkout with no environment configured.
    withAdminContext.mockRejectedValue(
      new Error("DATABASE_URL is not set. Configure it in the environment (see .env.example)."),
    );
    const { lookupInviteByToken } = await import("@/lib/invite-acceptance");

    await expect(lookupInviteByToken("some-token")).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("reports `unavailable` when the database refuses the connection", async () => {
    withAdminContext.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
    const { lookupInviteByToken } = await import("@/lib/invite-acceptance");

    await expect(lookupInviteByToken("some-token")).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("does not disguise an outage as an invalid link", async () => {
    withAdminContext.mockRejectedValue(new Error("terminating connection due to administrator command"));
    const { lookupInviteByToken } = await import("@/lib/invite-acceptance");

    const result = await lookupInviteByToken("a-perfectly-good-token");

    // The whole distinction: telling this member their link is invalid would send
    // them to their gym for a replacement that fails in exactly the same way.
    expect(result.status).not.toBe("invalid");
  });

  it("still reports the failure for monitoring rather than swallowing it", async () => {
    const boom = new Error("connect ETIMEDOUT");
    withAdminContext.mockRejectedValue(boom);
    const { lookupInviteByToken } = await import("@/lib/invite-acceptance");

    await lookupInviteByToken("some-token");

    // Degrading gracefully must not make a real outage invisible to operators.
    expect(reportHandledError).toHaveBeenCalledWith(
      boom,
      "invite-lookup",
      expect.objectContaining({ severity: "error" }),
    );
  });

  it("classifies a token with no matching row as invalid, without querying twice", async () => {
    respondWith([]);
    const { lookupInviteByToken } = await import("@/lib/invite-acceptance");

    await expect(lookupInviteByToken("no-such-token")).resolves.toEqual({
      status: "invalid",
    });
    expect(withAdminContext).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing token without touching the database at all", async () => {
    const { lookupInviteByToken } = await import("@/lib/invite-acceptance");

    await expect(lookupInviteByToken(undefined)).resolves.toEqual({ status: "invalid" });
    expect(withAdminContext).not.toHaveBeenCalled();
  });

  it("still resolves a valid pending invite (the happy path is unchanged)", async () => {
    respondWith([
      {
        invite_id: "inv-1",
        tenant_id: "gym-1",
        member_id: "mem-1",
        email: "member@example.test",
        invite_status: "pending",
        // Comfortably in the future relative to any run of this suite.
        expires_at: "2099-01-01T00:00:00Z",
        member_name: "Maria",
        member_auth_user_id: null,
      },
    ]);
    const { lookupInviteByToken } = await import("@/lib/invite-acceptance");

    await expect(lookupInviteByToken("good-token")).resolves.toEqual({
      status: "valid",
      inviteId: "inv-1",
      tenantId: "gym-1",
      memberId: "mem-1",
      email: "member@example.test",
      memberName: "Maria",
    });
  });

  it("still distinguishes used and expired invites", async () => {
    respondWith([
      {
        invite_id: "inv-2",
        tenant_id: "gym-1",
        member_id: "mem-2",
        email: "used@example.test",
        invite_status: "accepted",
        expires_at: "2099-01-01T00:00:00Z",
        member_name: "Petros",
        member_auth_user_id: "auth-2",
      },
    ]);
    let mod = await import("@/lib/invite-acceptance");
    expect((await mod.lookupInviteByToken("used-token")).status).toBe("used");

    vi.resetModules();
    respondWith([
      {
        invite_id: "inv-3",
        tenant_id: "gym-1",
        member_id: "mem-3",
        email: "old@example.test",
        invite_status: "pending",
        expires_at: "2020-01-01T00:00:00Z",
        member_name: "Elena",
        member_auth_user_id: null,
      },
    ]);
    mod = await import("@/lib/invite-acceptance");
    expect((await mod.lookupInviteByToken("old-token")).status).toBe("expired");
  });
});
