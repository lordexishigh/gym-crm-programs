import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import { closePool, withAdminContext, withTenantContext, type Identity } from "../lib/db";
import {
  claimDue,
  completeTask,
  dedupeKey,
  enqueue,
  failTask,
  pruneCompletedTasks,
} from "../lib/tasks";
import {
  createSuggestion,
  listPendingSuggestions,
  reviewSuggestion,
  suggestionsForMember,
  supersedePending,
  type Observation,
} from "../lib/suggestions";
import { sweepScheduledWork, TASK_KINDS } from "../lib/task-handlers";

/**
 * Task-queue and suggestion-ledger behaviour against a real Postgres
 * (migrations 0020 and 0021).
 *
 * Two things are proved here that cannot be proved without a database, because
 * both are enforced BY the database rather than by application code:
 *
 *   - the idempotency guarantee (the unique dedupe index) and the lease
 *     semantics (`FOR UPDATE SKIP LOCKED`), which together are what turned
 *     "seven emails per renewal" into one;
 *   - isolation on both new tables: a gym sees only its own queue and its own
 *     suggestions, members see neither, and no session can write across tenants.
 *
 * Requires a real PostgreSQL 16 instance (CI provides DATABASE_URL); skipped
 * locally with a notice when absent.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn(
    "[task-queue-rls.test] DATABASE_URL not set — skipping (runs in CI).",
  );
}

type Seed = {
  gymA: string;
  gymB: string;
  memberA: string;
  memberB: string;
  programA: string;
};

const seed = {} as Seed;
const staff = (tenantId: string): Identity => ({ tenantId, role: "staff" });
const asMember = (tenantId: string, memberId: string): Identity => ({
  tenantId,
  role: "member",
  memberId,
});

const KIND = "test_kind";

/** Two anchored first-party observations — priced 'strong' by the ledger. */
const evidence = (ref: string): Observation[] => [
  { source: "workout_log.last-session", observed: "Last session 3 July.", ref },
  { source: "workout_log.window-count", observed: "0 in 30 days." },
];

describe.skipIf(!hasDb)("task queue and suggestion ledger", () => {
  beforeAll(async () => {
    await runMigrations();
    await withAdminContext(async (c) => {
      const gym = async (name: string) =>
        (await c.query("insert into gym (name) values ($1) returning id", [name]))
          .rows[0].id as string;
      const mem = async (tenant: string, name: string) =>
        (
          await c.query(
            "insert into member (tenant_id, full_name) values ($1, $2) returning id",
            [tenant, name],
          )
        ).rows[0].id as string;

      const gymA = await gym("TQ Gym A");
      const gymB = await gym("TQ Gym B");
      const memberA = await mem(gymA, "TQ Member A");
      const memberB = await mem(gymB, "TQ Member B");
      const programA = (
        await c.query(
          "insert into program (tenant_id, name) values ($1, $2) returning id",
          [gymA, "TQ Program A"],
        )
      ).rows[0].id as string;

      Object.assign(seed, { gymA, gymB, memberA, memberB, programA });
    });
  });

  afterAll(async () => {
    await closePool();
  });

  // --- Idempotency ---------------------------------------------------------

  describe("enqueue dedupe", () => {
    it("enqueues an occasion once, however many times it is swept", async () => {
      const key = dedupeKey("renewal", "once", "2026-09-01");
      const first = await enqueue({ tenantId: seed.gymA, kind: KIND, dedupeKey: key });
      const second = await enqueue({ tenantId: seed.gymA, kind: KIND, dedupeKey: key });
      const third = await enqueue({ tenantId: seed.gymA, kind: KIND, dedupeKey: key });

      // This is the bug fix, expressed as a test: seven daily sweeps over one
      // renewal must produce ONE task, therefore one email.
      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(third).toBe(false);
    });

    it("treats the same key in another gym as a different occasion", async () => {
      const key = dedupeKey("renewal", "shared-key");
      expect(
        await enqueue({ tenantId: seed.gymA, kind: KIND, dedupeKey: key }),
      ).toBe(true);
      // Uniqueness is per (tenant, kind, key) — one gym's dedupe must never
      // suppress another's work.
      expect(
        await enqueue({ tenantId: seed.gymB, kind: KIND, dedupeKey: key }),
      ).toBe(true);
    });

    it("still dedupes after the task has been completed", async () => {
      const key = dedupeKey("renewal", "completed");
      await enqueue({ tenantId: seed.gymA, kind: KIND, dedupeKey: key });
      const [claimed] = await claimDue({ limit: 1 });
      await completeTask(claimed.id);

      // A completed row is NOT disposable: while it survives, the occasion
      // cannot be re-enqueued. Deleting it would be a re-send waiting to happen.
      expect(
        await enqueue({ tenantId: seed.gymA, kind: KIND, dedupeKey: key }),
      ).toBe(false);
    });
  });

  // --- Leasing -------------------------------------------------------------

  describe("claimDue", () => {
    it("increments attempts at claim time, not at failure time", async () => {
      await enqueue({
        tenantId: seed.gymA,
        kind: KIND,
        dedupeKey: dedupeKey("lease", "attempts"),
      });
      const claimed = await claimDue({ limit: 10 });
      const mine = claimed.find((t) => t.dedupe_key === "lease:attempts");

      // Counting on claim is what stops a task that KILLS its worker from
      // retrying forever: it never reaches a failure handler, but it has still
      // spent an attempt.
      expect(mine?.attempts).toBe(1);
    });

    it("does not hand a leased task to a second dispatcher", async () => {
      await enqueue({
        tenantId: seed.gymA,
        kind: KIND,
        dedupeKey: dedupeKey("lease", "exclusive"),
      });
      const first = await claimDue({ limit: 50, leaseSeconds: 300 });
      expect(first.some((t) => t.dedupe_key === "lease:exclusive")).toBe(true);

      const second = await claimDue({ limit: 50, leaseSeconds: 300 });
      expect(second.some((t) => t.dedupe_key === "lease:exclusive")).toBe(false);
    });

    it("does not claim a task whose due_at is in the future", async () => {
      await enqueue({
        tenantId: seed.gymA,
        kind: KIND,
        dedupeKey: dedupeKey("lease", "future"),
        dueAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      const claimed = await claimDue({ limit: 50 });
      expect(claimed.some((t) => t.dedupe_key === "lease:future")).toBe(false);
    });

    it("reclaims a task whose lease has expired", async () => {
      // The crash-recovery path: a dispatcher that dies mid-task leaves the row
      // leased, not lost. A 1-second lease stands in for a dead worker.
      await enqueue({
        tenantId: seed.gymA,
        kind: KIND,
        dedupeKey: dedupeKey("lease", "expired"),
      });
      const first = await claimDue({ limit: 50, leaseSeconds: 1 });
      expect(first.some((t) => t.dedupe_key === "lease:expired")).toBe(true);

      await new Promise((r) => setTimeout(r, 1_200));

      const second = await claimDue({ limit: 50 });
      const again = second.find((t) => t.dedupe_key === "lease:expired");
      expect(again).toBeDefined();
      expect(again!.attempts).toBe(2);
    });
  });

  // --- Failure handling ----------------------------------------------------

  describe("failTask", () => {
    it("reschedules with backoff while attempts remain, then parks", async () => {
      await enqueue({
        tenantId: seed.gymA,
        kind: KIND,
        dedupeKey: dedupeKey("fail", "parks"),
        maxAttempts: 1,
      });
      const claimed = await claimDue({ limit: 50 });
      const task = claimed.find((t) => t.dedupe_key === "fail:parks")!;

      await failTask(task.id, new Error("provider exploded"), task.attempts, 1);

      const row = await withAdminContext(async (c) =>
        (
          await c.query(
            "select status, last_error from tasks where id = $1",
            [task.id],
          )
        ).rows[0],
      );
      // Parked, with the reason attached — a permanently broken task must stop
      // burning dispatcher budget but stay visible to a human.
      expect(row.status).toBe("failed");
      expect(row.last_error).toMatch(/provider exploded/);
    });

    it("keeps a retryable task pending and pushes its due_at out", async () => {
      await enqueue({
        tenantId: seed.gymA,
        kind: KIND,
        dedupeKey: dedupeKey("fail", "retries"),
        maxAttempts: 5,
      });
      const claimed = await claimDue({ limit: 50 });
      const task = claimed.find((t) => t.dedupe_key === "fail:retries")!;

      await failTask(task.id, new Error("transient"), task.attempts, 5);

      const row = await withAdminContext(async (c) =>
        (
          await c.query(
            "select status, leased_until, due_at > now() as deferred from tasks where id = $1",
            [task.id],
          )
        ).rows[0],
      );
      expect(row.status).toBe("pending");
      expect(row.leased_until).toBeNull();
      expect(row.deferred).toBe(true);
    });
  });

  describe("pruneCompletedTasks", () => {
    it("leaves recently-finished rows alone", async () => {
      // The dedupe window depends on completed rows surviving, so the prune must
      // never take a fresh one.
      const before = await withAdminContext(async (c) =>
        Number(
          (await c.query("select count(*)::int as n from tasks")).rows[0].n,
        ),
      );
      const deleted = await pruneCompletedTasks(90);
      const after = await withAdminContext(async (c) =>
        Number(
          (await c.query("select count(*)::int as n from tasks")).rows[0].n,
        ),
      );
      expect(deleted).toBe(0);
      expect(after).toBe(before);
    });
  });

  // --- The sweep -----------------------------------------------------------

  describe("sweepScheduledWork", () => {
    it("does not enqueue per-tenant work for a gym with no active members", async () => {
      // Not an optimisation — a correctness property under real conditions. The
      // production database carries ~154 junk tenants left by the RLS suites,
      // which seed conflicting gyms and never clean up. Enqueueing per-tenant
      // sweeps for all of them would file ~310 tasks a day against a dispatcher
      // that claims 25 per run on a daily cron, so the queue would never drain
      // and the one real gym's reminders would queue behind work for phantoms.
      const emptyGym = await withAdminContext(
        async (c) =>
          (
            await c.query(
              "insert into gym (name) values ('TQ Empty Gym') returning id",
            )
          ).rows[0].id as string,
      );

      await sweepScheduledWork(new Date());

      const kinds = await withAdminContext(async (c) =>
        (
          await c.query("select kind from tasks where tenant_id = $1", [
            emptyGym,
          ])
        ).rows.map((r) => r.kind as string),
      );
      expect(kinds).not.toContain(TASK_KINDS.atRiskBriefs);
      expect(kinds).not.toContain(TASK_KINDS.waitlistPromotionNotify);
    });

    it("does enqueue an at-risk sweep for a gym that has active members", async () => {
      await sweepScheduledWork(new Date());

      const kinds = await withAdminContext(async (c) =>
        (
          await c.query("select kind from tasks where tenant_id = $1", [
            seed.gymA,
          ])
        ).rows.map((r) => r.kind as string),
      );
      expect(kinds).toContain(TASK_KINDS.atRiskBriefs);
    });

    it("is idempotent — a second sweep in the same week enqueues nothing new", async () => {
      await sweepScheduledWork(new Date());
      const { enqueued } = await sweepScheduledWork(new Date());
      // The whole point of the dedupe key: the cron may fire as often as it
      // likes, and a backup trigger may fire alongside it.
      expect(enqueued).toBe(0);
    });
  });

  // --- Queue isolation -----------------------------------------------------

  describe("tasks isolation", () => {
    it("shows staff only their own gym's queue", async () => {
      await enqueue({
        tenantId: seed.gymA,
        kind: KIND,
        dedupeKey: dedupeKey("iso", "gym-a"),
      });
      await enqueue({
        tenantId: seed.gymB,
        kind: KIND,
        dedupeKey: dedupeKey("iso", "gym-b"),
      });

      const visibleToA = await withTenantContext(staff(seed.gymA), async (c) =>
        (await c.query("select dedupe_key from tasks")).rows.map(
          (r) => r.dedupe_key as string,
        ),
      );
      expect(visibleToA).toContain("iso:gym-a");
      expect(visibleToA).not.toContain("iso:gym-b");
    });

    it("hides the queue from members entirely", async () => {
      const visible = await withTenantContext(
        asMember(seed.gymA, seed.memberA),
        async (c) => (await c.query("select id from tasks")).rowCount,
      );
      // No member policy exists, so RLS denies every row. Payloads reference
      // other members.
      expect(visible).toBe(0);
    });

    it("refuses a staff insert into the queue", async () => {
      // Deliberately no staff INSERT policy: a staff-writable queue would let a
      // gym schedule arbitrary kinds with arbitrary payloads against our own
      // handlers.
      await expect(
        withTenantContext(staff(seed.gymA), async (c) =>
          c.query(
            "insert into tasks (tenant_id, kind, dedupe_key) values ($1, $2, $3)",
            [seed.gymA, KIND, "forged"],
          ),
        ),
      ).rejects.toThrow();
    });
  });

  // --- Suggestion ledger ---------------------------------------------------

  describe("suggestions", () => {
    it("records a suggestion and prices its evidence", async () => {
      const created = await createSuggestion(staff(seed.gymA), {
        kind: "at_risk_brief",
        memberId: seed.memberA,
        headline: "TQ Member A has not trained in 31 days.",
        observations: evidence(seed.memberA),
        source: "rules:at-risk-v1",
        dedupeKey: "ledger:priced",
      });

      expect(created).not.toBeNull();
      // Priced from the observations, not self-reported by the caller — note
      // that `createSuggestion` takes no strength argument at all.
      expect(created!.strength).toBe("strong");
      expect(created!.status).toBe("pending");
    });

    it("prices model-sourced evidence as weak", async () => {
      const created = await createSuggestion(staff(seed.gymA), {
        kind: "at_risk_brief",
        memberId: seed.memberA,
        headline: "Generated summary.",
        observations: [
          { source: "llm:claude-opus-5.summary", observed: "seems disengaged", ref: seed.memberA },
          { source: "llm:claude-opus-5.summary", observed: "probably busy", ref: seed.memberA },
        ],
        source: "llm:claude-opus-5",
        dedupeKey: "ledger:model",
      });
      // The safety ceiling: no volume of generated evidence reaches 'strong'.
      expect(created!.strength).toBe("weak");
    });

    it("files one suggestion per occasion", async () => {
      const input = {
        kind: "at_risk_brief",
        memberId: seed.memberA,
        headline: "Duplicate occasion.",
        observations: evidence(seed.memberA),
        source: "rules:at-risk-v1",
        dedupeKey: "ledger:dedupe",
      };
      expect(await createSuggestion(staff(seed.gymA), input)).not.toBeNull();
      // Re-running a generator must not pile duplicates onto a trainer's queue.
      expect(await createSuggestion(staff(seed.gymA), input)).toBeNull();
    });

    it("rejects a suggestion with no evidence at the database level", async () => {
      // The application validates too, but the CHECK is the real guarantee: a
      // suggestion with no evidence is a guess, not a suggestion.
      await expect(
        withTenantContext(staff(seed.gymA), async (c) =>
          c.query(
            `insert into suggestions
               (tenant_id, kind, member_id, headline, evidence, strength, source, dedupe_key)
             values ($1, 'x', $2, 'no evidence', '[]'::jsonb, 'weak', 'test', 'ledger:empty')`,
            [seed.gymA, seed.memberA],
          ),
        ),
      ).rejects.toThrow();
    });

    it("rejects a suggestion with two subjects", async () => {
      await expect(
        withTenantContext(staff(seed.gymA), async (c) =>
          c.query(
            `insert into suggestions
               (tenant_id, kind, member_id, program_id, headline, evidence, strength, source, dedupe_key)
             values ($1, 'x', $2, $3, 'two subjects',
                     '[{"source":"a.b","observed":"c"}]'::jsonb, 'weak', 'test', 'ledger:both')`,
            [seed.gymA, seed.memberA, seed.programA],
          ),
        ),
      ).rejects.toThrow();
    });

    it("keeps one gym's suggestions invisible to another", async () => {
      await createSuggestion(staff(seed.gymB), {
        kind: "at_risk_brief",
        memberId: seed.memberB,
        headline: "Gym B's member.",
        observations: evidence(seed.memberB),
        source: "rules:at-risk-v1",
        dedupeKey: "ledger:gym-b",
      });

      const pendingForA = await listPendingSuggestions(staff(seed.gymA));
      expect(pendingForA.every((s) => s.headline !== "Gym B's member.")).toBe(true);

      // And a direct id lookup across tenants resolves to nothing.
      const crossTenant = await suggestionsForMember(
        staff(seed.gymA),
        seed.memberB,
      );
      expect(crossTenant).toHaveLength(0);
    });

    it("hides suggestions from members", async () => {
      // A pending "this member is disengaging" brief shown to the member would
      // be both wrong and unkind.
      const visible = await withTenantContext(
        asMember(seed.gymA, seed.memberA),
        async (c) => (await c.query("select id from suggestions")).rowCount,
      );
      expect(visible).toBe(0);
    });

    it("refuses to create a suggestion from a member identity", async () => {
      await expect(
        createSuggestion(asMember(seed.gymA, seed.memberA), {
          kind: "at_risk_brief",
          memberId: seed.memberA,
          headline: "Self-filed.",
          observations: evidence(seed.memberA),
          source: "rules:at-risk-v1",
          dedupeKey: "ledger:member",
        }),
      ).rejects.toThrow(/staff identity/);
    });

    it("records the decision once, and ignores a second decision", async () => {
      const created = await createSuggestion(staff(seed.gymA), {
        kind: "at_risk_brief",
        memberId: seed.memberA,
        headline: "To be reviewed.",
        observations: evidence(seed.memberA),
        source: "rules:at-risk-v1",
        dedupeKey: "ledger:review",
      });

      const first = await reviewSuggestion(
        staff(seed.gymA),
        created!.id,
        "accepted",
        "called her",
      );
      expect(first).toBe(true);

      // A double-submit, or a colleague getting there first, must not overwrite
      // the first decision or its author.
      const second = await reviewSuggestion(
        staff(seed.gymA),
        created!.id,
        "dismissed",
      );
      expect(second).toBe(false);

      const row = await withTenantContext(staff(seed.gymA), async (c) =>
        (
          await c.query(
            "select status, review_note, reviewed_at from suggestions where id = $1",
            [created!.id],
          )
        ).rows[0],
      );
      expect(row.status).toBe("accepted");
      expect(row.review_note).toBe("called her");
      expect(row.reviewed_at).not.toBeNull();
    });

    it("cannot review another gym's suggestion", async () => {
      const created = await createSuggestion(staff(seed.gymB), {
        kind: "at_risk_brief",
        memberId: seed.memberB,
        headline: "Gym B's to review.",
        observations: evidence(seed.memberB),
        source: "rules:at-risk-v1",
        dedupeKey: "ledger:cross-review",
      });

      // RLS hides the row from gym A, so the guarded UPDATE matches nothing.
      expect(
        await reviewSuggestion(staff(seed.gymA), created!.id, "dismissed"),
      ).toBe(false);
    });

    it("supersedes stale pending suggestions without deleting them", async () => {
      await createSuggestion(staff(seed.gymA), {
        kind: "stale_kind",
        memberId: seed.memberA,
        headline: "Stale.",
        observations: evidence(seed.memberA),
        source: "rules:at-risk-v1",
        dedupeKey: "ledger:stale",
      });

      const count = await supersedePending(
        staff(seed.gymA),
        "stale_kind",
        seed.memberA,
      );
      expect(count).toBe(1);

      // The row survives: it is the record that we once thought this, which is
      // the point of a ledger.
      const all = await suggestionsForMember(staff(seed.gymA), seed.memberA);
      expect(all.some((s) => s.status === "superseded")).toBe(true);
    });

    it("removes a member's suggestions when the member is erased", async () => {
      // GDPR-relevant: the ON DELETE CASCADE means erasure takes every derived
      // claim about a person with it, by construction rather than by remembering
      // to add this table to the erasure path.
      await withAdminContext(async (c) => {
        const gymC = (
          await c.query("insert into gym (name) values ('TQ Gym C') returning id")
        ).rows[0].id as string;
        const memberC = (
          await c.query(
            "insert into member (tenant_id, full_name) values ($1, 'TQ Member C') returning id",
            [gymC],
          )
        ).rows[0].id as string;

        await c.query(
          `insert into suggestions
             (tenant_id, kind, member_id, headline, evidence, strength, source, dedupe_key)
           values ($1, 'at_risk_brief', $2, 'Doomed.',
                   '[{"source":"a.b","observed":"c"}]'::jsonb, 'weak', 'test', 'ledger:cascade')`,
          [gymC, memberC],
        );

        await c.query("delete from member where id = $1", [memberC]);

        const remaining = (
          await c.query(
            "select count(*)::int as n from suggestions where member_id = $1",
            [memberC],
          )
        ).rows[0].n as number;
        expect(remaining).toBe(0);
      });
    });
  });
});
