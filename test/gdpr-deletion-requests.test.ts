import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import {
  closePool,
  withAdminContext,
  withTenantContext,
  type Identity,
} from "../lib/db";
import {
  completeDeletionRequest,
  declineDeletionRequest,
  latestDeletionRequestForMember,
  listPendingDeletionRequests,
  normaliseNote,
  submitDeletionRequest,
} from "../lib/gdpr/deletion-requests";
import { ERASED_MEMBER_NAME } from "../lib/gdpr/export";
import {
  ROSTER_PAGE_SIZE,
  memberRosterWhere,
  rosterListSql,
  type RosterMemberRow,
} from "../lib/members";
import { ADHERENCE_WINDOW_DAYS } from "../lib/workout-logs";

/**
 * Member PII erasure WORKFLOW (beta-gdpr-002).
 *
 * `gdpr-erasure.test.ts` covers the mechanism — what anonymisation does to a
 * member row. This suite covers the request/decision loop built on top of it,
 * which is the part the acceptance criteria describe end to end:
 *
 *   1. the member files the request from their own portal session;
 *   2. the gym's staff see it as pending work (and no other gym does);
 *   3. confirming it tombstones the member and closes the request;
 *   4. the member no longer appears in the staff roster query;
 *   5. declining it records a reason the member can read.
 *
 * The isolation assertions matter as much as the happy path: the request is
 * member-supplied, so "a member can only ever file/read their own" has to hold
 * at the RLS layer (migration 0026), not just in the Server Action.
 *
 * Requires a real PostgreSQL 16 instance (provided in CI via DATABASE_URL).
 * Skipped locally with a notice when DATABASE_URL is absent.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn(
    "[gdpr-deletion-requests.test] DATABASE_URL not set — skipping (runs in CI).",
  );
}

const staff = (tenantId: string): Identity => ({ tenantId, role: "staff" });
const member = (tenantId: string, memberId: string): Identity => ({
  tenantId,
  role: "member",
  memberId,
});

/** Insert a gym with one member, returning both ids. */
async function seedGym(
  name: string,
  memberName: string,
  email: string | null,
): Promise<{ gymId: string; memberId: string }> {
  return withAdminContext(async (c) => {
    const gymId = (
      await c.query("insert into gym (name) values ($1) returning id", [name])
    ).rows[0].id as string;
    const memberId = (
      await c.query(
        "insert into member (tenant_id, full_name, email) values ($1, $2, $3) returning id",
        [gymId, memberName, email],
      )
    ).rows[0].id as string;
    return { gymId, memberId };
  });
}

/** Run the roster list query exactly as /dashboard/members does. */
async function rosterNames(identity: Identity): Promise<string[]> {
  const { clause, params } = memberRosterWhere({ q: "", status: "all", page: 1 });
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<RosterMemberRow>(
      rosterListSql(clause, params.length),
      [...params, ADHERENCE_WINDOW_DAYS, ROSTER_PAGE_SIZE, 0],
    );
    return rows.map((r) => r.full_name);
  });
}

describe("normaliseNote (pure)", () => {
  it("trims, and treats blank as absent", () => {
    expect(normaliseNote("  moving away  ")).toBe("moving away");
    expect(normaliseNote("   ")).toBeNull();
    expect(normaliseNote("")).toBeNull();
    expect(normaliseNote(undefined)).toBeNull();
    expect(normaliseNote(null)).toBeNull();
    // Non-string form values (a File, say) must not become "[object File]".
    expect(normaliseNote({ toString: () => "nope" })).toBeNull();
  });

  it("caps runaway free text rather than letting the insert fail", () => {
    expect(normaliseNote("x".repeat(5000))).toHaveLength(1000);
  });
});

describe.skipIf(!hasDb)("member erasure request workflow", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("a member files a request their gym then sees as pending", async () => {
    const { gymId, memberId } = await seedGym(
      "Req Gym Pending",
      "Nadia Requester",
      "nadia@pending.example",
    );

    const submitted = await submitDeletionRequest(
      member(gymId, memberId),
      memberId,
      "I am moving to Greece.",
    );
    expect(submitted).toEqual({ ok: true, alreadyPending: false });

    // The member sees their own request's state in the portal.
    const own = await latestDeletionRequestForMember(
      member(gymId, memberId),
      memberId,
    );
    expect(own?.status).toBe("pending");
    expect(own?.decided_at).toBeNull();

    // Staff see it as work, with the subject and their words.
    const queue = await listPendingDeletionRequests(staff(gymId));
    expect(queue).toHaveLength(1);
    expect(queue[0].member_id).toBe(memberId);
    expect(queue[0].member_name).toBe("Nadia Requester");
    expect(queue[0].member_email).toBe("nadia@pending.example");
    expect(queue[0].reason).toBe("I am moving to Greece.");
  });

  it("a second request does not queue a duplicate for staff to decide twice", async () => {
    const { gymId, memberId } = await seedGym(
      "Req Gym Idem",
      "Twice Tapper",
      "twice@idem.example",
    );

    expect(
      await submitDeletionRequest(member(gymId, memberId), memberId, "first"),
    ).toEqual({ ok: true, alreadyPending: false });
    expect(
      await submitDeletionRequest(member(gymId, memberId), memberId, "again"),
    ).toEqual({ ok: true, alreadyPending: true });

    expect(await listPendingDeletionRequests(staff(gymId))).toHaveLength(1);
  });

  it("a member cannot file a request against another member", async () => {
    const { gymId, memberId } = await seedGym(
      "Req Gym Spoof",
      "Honest Member",
      "honest@spoof.example",
    );
    const victim = await withAdminContext(
      async (c) =>
        (
          await c.query(
            "insert into member (tenant_id, full_name) values ($1, 'Victim') returning id",
            [gymId],
          )
        ).rows[0].id as string,
    );

    // The session says memberId; the crafted argument says `victim`. Even in the
    // same gym, `member_self_select` (0002) makes another member's row invisible,
    // so the subject lookup finds nothing.
    expect(
      await submitDeletionRequest(member(gymId, memberId), victim, "not mine"),
    ).toEqual({ ok: false, reason: "not_found" });

    // And the insert itself is refused by the policy, not merely unreachable via
    // this helper — `member_deletion_request_member_insert` (0026) requires
    // `member_id = app_current_member()`. This is the assertion that would still
    // hold if the lookup above were ever relaxed.
    await expect(
      withTenantContext(member(gymId, memberId), (c) =>
        c.query(
          "insert into member_deletion_request (tenant_id, member_id) values ($1, $2)",
          [gymId, victim],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    expect(await listPendingDeletionRequests(staff(gymId))).toHaveLength(0);
  });

  it("does not leak a request across tenants, in either direction", async () => {
    const a = await seedGym("Req Gym A", "A Member", "a@cross.example");
    const b = await seedGym("Req Gym B", "B Member", "b@cross.example");

    await submitDeletionRequest(member(a.gymId, a.memberId), a.memberId, "mine");

    // Gym B's staff see nothing of gym A's request.
    expect(await listPendingDeletionRequests(staff(b.gymId))).toHaveLength(0);
    // Gym A's staff do.
    expect(await listPendingDeletionRequests(staff(a.gymId))).toHaveLength(1);
    // Gym B's member cannot read it even naming gym A's member id.
    expect(
      await latestDeletionRequestForMember(
        member(b.gymId, b.memberId),
        a.memberId,
      ),
    ).toBeNull();
    // And gym B's staff cannot decide it: RLS makes the row invisible.
    const requestId = (await listPendingDeletionRequests(staff(a.gymId)))[0].id;
    expect(await completeDeletionRequest(staff(b.gymId), requestId)).toEqual({
      ok: false,
      reason: "not_found",
    });
    // Gym A's member is untouched by that attempt.
    await withAdminContext(async (c) => {
      const row = (
        await c.query("select full_name, erased_at from member where id = $1", [
          a.memberId,
        ])
      ).rows[0];
      expect(row.full_name).toBe("A Member");
      expect(row.erased_at).toBeNull();
    });
  });

  it("confirming tombstones the member, closes the request, and drops them from the roster", async () => {
    const { gymId, memberId } = await seedGym(
      "Req Gym Confirm",
      "Gone Soon",
      "gone@confirm.example",
    );
    // A second member who must still be listed afterwards, so the assertion
    // below distinguishes "the erased one is filtered" from "the query broke".
    await withAdminContext(async (c) => {
      await c.query(
        "insert into member (tenant_id, full_name) values ($1, 'Stays Listed')",
        [gymId],
      );
    });

    await submitDeletionRequest(
      member(gymId, memberId),
      memberId,
      "delete everything please",
    );
    const requestId = (await listPendingDeletionRequests(staff(gymId)))[0].id;

    expect(await rosterNames(staff(gymId)).then((n) => n.sort())).toEqual([
      "Gone Soon",
      "Stays Listed",
    ]);

    const result = await completeDeletionRequest(staff(gymId), requestId);
    expect(result.ok).toBe(true);
    // No mail provider in the test environment, so the send does not land — the
    // outcome is RECORDED rather than swallowed, which is the point.
    expect(result.ok && result.emailed).toMatch(/^(sent|failed|skipped)$/);

    await withAdminContext(async (c) => {
      // Tombstone-only member record.
      const m = (
        await c.query(
          "select full_name, email, phone, notes, auth_user_id, erased_at from member where id = $1",
          [memberId],
        )
      ).rows[0];
      expect(m.full_name).toBe(ERASED_MEMBER_NAME);
      expect(m.email).toBeNull();
      expect(m.erased_at).not.toBeNull();

      // Request closed, decision + notification outcome recorded, and the
      // member's own words scrubbed (the skeleton is the evidence, the prose
      // was personal data).
      const r = (
        await c.query(
          "select status, decided_at, reason, confirmation_email from member_deletion_request where id = $1",
          [requestId],
        )
      ).rows[0];
      expect(r.status).toBe("completed");
      expect(r.decided_at).not.toBeNull();
      expect(r.reason).toBeNull();
      expect(r.confirmation_email).not.toBeNull();

      // The decision is auditable on top of the erasure event itself.
      const audit = (
        await c.query<{ n: number }>(
          `select count(*)::int as n from gdpr_audit_event
            where action = 'erasure' and subject_member_id = $1
              and detail->>'decision' = 'completed'`,
          [memberId],
        )
      ).rows[0];
      expect(audit.n).toBe(1);
    });

    // The acceptance criterion: gone from the staff-facing roster.
    expect(await rosterNames(staff(gymId))).toEqual(["Stays Listed"]);
    // Nothing left in the queue.
    expect(await listPendingDeletionRequests(staff(gymId))).toHaveLength(0);
  });

  it("confirming twice reports not_found rather than re-erasing", async () => {
    const { gymId, memberId } = await seedGym(
      "Req Gym Double",
      "Double Confirm",
      "double@confirm.example",
    );
    await submitDeletionRequest(member(gymId, memberId), memberId, null);
    const requestId = (await listPendingDeletionRequests(staff(gymId)))[0].id;

    expect((await completeDeletionRequest(staff(gymId), requestId)).ok).toBe(true);
    expect(await completeDeletionRequest(staff(gymId), requestId)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("declining records a reason the member can read, and keeps their data", async () => {
    const { gymId, memberId } = await seedGym(
      "Req Gym Decline",
      "Stays Put",
      "stays@decline.example",
    );
    await submitDeletionRequest(member(gymId, memberId), memberId, "please");
    const requestId = (await listPendingDeletionRequests(staff(gymId)))[0].id;

    expect(
      await declineDeletionRequest(
        staff(gymId),
        requestId,
        "We must keep your accident report for seven years.",
      ),
    ).toEqual({ ok: true });

    // The member sees the refusal AND its reason in their portal.
    const own = await latestDeletionRequestForMember(
      member(gymId, memberId),
      memberId,
    );
    expect(own?.status).toBe("declined");
    expect(own?.decision_note).toBe(
      "We must keep your accident report for seven years.",
    );

    // Their data is intact and they are still on the roster.
    expect(await rosterNames(staff(gymId))).toEqual(["Stays Put"]);
    // The queue is clear — a declined request is decided, not pending.
    expect(await listPendingDeletionRequests(staff(gymId))).toHaveLength(0);
    // And a declined request can be re-filed (circumstances change).
    expect(
      await submitDeletionRequest(member(gymId, memberId), memberId, "asking again"),
    ).toEqual({ ok: true, alreadyPending: false });
  });

  it("an already-erased member cannot file a request", async () => {
    const { gymId, memberId } = await seedGym(
      "Req Gym Erased",
      "Already Gone",
      null,
    );
    await withAdminContext(async (c) => {
      await c.query("update member set erased_at = now() where id = $1", [
        memberId,
      ]);
    });

    expect(
      await submitDeletionRequest(member(gymId, memberId), memberId, null),
    ).toEqual({ ok: false, reason: "already_erased" });
  });

  it("a member cannot decide their own request", async () => {
    const { gymId, memberId } = await seedGym(
      "Req Gym SelfDecide",
      "Impatient",
      "impatient@self.example",
    );
    await submitDeletionRequest(member(gymId, memberId), memberId, null);
    const requestId = (await listPendingDeletionRequests(staff(gymId)))[0].id;

    // There is no member UPDATE policy on member_deletion_request, so the
    // update matches nothing under a member session — the member cannot skip
    // the controller's decision and mark their own request completed.
    const updated = await withTenantContext(
      member(gymId, memberId),
      async (c) =>
        (
          await c.query(
            "update member_deletion_request set status = 'completed' where id = $1",
            [requestId],
          )
        ).rowCount ?? 0,
    );
    expect(updated).toBe(0);

    // Still pending for staff.
    expect(await listPendingDeletionRequests(staff(gymId))).toHaveLength(1);
  });
});
