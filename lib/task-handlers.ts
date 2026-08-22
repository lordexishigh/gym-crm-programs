import { withAdminContext, withTenantContext, type Identity } from "@/lib/db";
import {
  claimDue,
  completeTask,
  dayStamp,
  dedupeKey,
  enqueueMany,
  failTask,
  type EnqueueInput,
  type TaskRow,
} from "@/lib/tasks";
import { hasCapability } from "@/lib/capabilities";
import { generateAtRiskBriefs, isoWeek } from "@/lib/briefs";
import { markPromotionNotified, unnotifiedPromotions } from "@/lib/classes";
import {
  notifyWaitlistPromotions,
  sendMembershipExpiryEmail,
} from "@/lib/notifications";
import { captureException } from "@/lib/observability/monitoring";

/**
 * The handlers behind each `tasks.kind`, plus the sweep that enqueues work and
 * the dispatcher that drains it.
 *
 * Split from lib/tasks.ts on purpose: that module is the queue mechanism and
 * knows nothing about gyms, and this one is the domain work and knows nothing
 * about leases. Adding a scheduled feature means adding a handler and a sweep
 * clause here — no new script, no new workflow file, no new deploy target.
 *
 * The tenant boundary, restated because it is the security-relevant part:
 * claiming is cross-tenant (one dispatcher, no session), but every handler does
 * its data access inside `withTenantContext` under `systemIdentity(task
 * .tenant_id)`. A handler that mishandles an id therefore reads nothing, rather
 * than reading another gym's rows.
 */

/**
 * The identity a scheduled job runs as: staff-audience, scoped to one tenant,
 * with NO user id.
 *
 * Staff-audience because that is what the RLS policies gate on
 * (`app_current_role() = 'staff'`) and scheduled work legitimately reads what
 * staff read. No user id because a scheduled job has no author — and that
 * absence is load-bearing rather than a gap: anything deriving authorship from
 * the session (`suggestions.reviewed_by`, `program.created_by`) records null,
 * so a system-created row is distinguishable from a trainer's, forever. Filling
 * it with a placeholder user would quietly attribute machine output to a person.
 */
export function systemIdentity(tenantId: string): Identity {
  return { tenantId, role: "staff", userId: null, memberId: null };
}

/** Registered task kinds. */
export const TASK_KINDS = {
  membershipExpiryReminder: "membership_expiry_reminder",
  atRiskBriefs: "at_risk_briefs",
  waitlistPromotionNotify: "waitlist_promotion_notify",
} as const;

export type TaskHandler = (task: TaskRow) => Promise<void>;

/**
 * Refuse to run an email task on a deployment that cannot send email.
 *
 * The alternative — letting it "succeed" — is the exact failure this whole
 * change set is about: `sendEmail()` returns `not_configured`,
 * `sendBestEffort` swallows it by design, the task completes, and the queue
 * reports a clean run while no member was ever contacted. Throwing instead makes
 * the task retry, then park at 'failed' with a legible reason, so the gap shows
 * up in three places that are actually looked at: the queue, /api/health's
 * `capability_gaps`, and the dashboard notice.
 *
 * Non-email handlers deliberately do NOT gate on this — at-risk briefs are
 * written to the ledger and read in the dashboard, so they remain fully useful
 * on a deployment with no mail provider.
 */
function requireEmailCapability(kind: string): void {
  if (!hasCapability("email")) {
    throw new Error(
      `${kind} needs transactional email, which is not configured on this deployment ` +
        "(RESEND_API_KEY and INVITE_FROM_EMAIL — see .env.example). " +
        "Nothing was sent.",
    );
  }
}

/**
 * Email one member that their membership renews soon.
 *
 * Re-reads the plan under the tenant's own identity rather than trusting the
 * payload. A task may sit in the queue for hours, and in that time the member
 * may have cancelled, switched plan, or already renewed — emailing a stale
 * reminder is worse than sending nothing. A plan that no longer matches is
 * treated as a SUCCESS, not a failure: the occasion is genuinely over, and
 * retrying would never make it true again.
 */
async function handleMembershipExpiryReminder(task: TaskRow): Promise<void> {
  const memberPlanId = String(task.payload.memberPlanId ?? "");
  if (!memberPlanId) {
    throw new Error("membership_expiry_reminder payload is missing memberPlanId.");
  }
  requireEmailCapability(TASK_KINDS.membershipExpiryReminder);

  const row = await withTenantContext(
    systemIdentity(task.tenant_id),
    async (c) => {
      const { rows } = await c.query<{
        email: string | null;
        full_name: string;
        plan_name: string;
        current_period_end: string;
      }>(
        `select m.email, m.full_name, p.name as plan_name, mp.current_period_end
           from member_plans mp
           join member m on m.id = mp.member_id
           join membership_plans p on p.id = mp.plan_id
          where mp.id = $1
            and mp.status = 'active'
            and mp.current_period_end is not null
            and mp.current_period_end >= now()`,
        [memberPlanId],
      );
      return rows[0] ?? null;
    },
  );

  // Cancelled, changed, or already past — the occasion no longer exists.
  if (!row || !row.email) return;

  await sendMembershipExpiryEmail({
    to: row.email,
    memberName: row.full_name,
    planName: row.plan_name,
    expiresAt: new Date(row.current_period_end),
  });
}

/** File this week's at-risk briefs for one gym. */
async function handleAtRiskBriefs(task: TaskRow): Promise<void> {
  const filed = await generateAtRiskBriefs(systemIdentity(task.tenant_id));
  if (filed > 0) {
    console.log(
      `[tasks] filed ${filed} at-risk brief(s) for tenant ${task.tenant_id}`,
    );
  }
}

/**
 * Email every promoted-but-unnotified waitlist member for one gym.
 *
 * The retry safety net for `promoteFromWaitlist`'s inline notification — see
 * `unnotifiedPromotions` (lib/classes.ts) for why one was needed.
 */
async function handleWaitlistPromotionNotify(task: TaskRow): Promise<void> {
  const pending = await unnotifiedPromotions(task.tenant_id);
  if (pending.length === 0) return;

  requireEmailCapability(TASK_KINDS.waitlistPromotionNotify);
  const result = await notifyWaitlistPromotions(pending);
  await markPromotionNotified(task.tenant_id, result.notified);

  // A partial result is not a failure — `notifyWaitlistPromotions` never throws,
  // and the rows it could not deliver keep their null marker, so the next sweep
  // retries exactly those. Reported so a persistent partial is visible.
  //
  // `emailed` rather than `notified.length`, because the latter also counts
  // members who have no address: a batch that is entirely address-less would
  // otherwise log a clean 5/5 having sent nothing.
  if (result.emailed < pending.length) {
    console.warn(
      `[tasks] waitlist notify: ${result.emailed}/${pending.length} emailed for tenant ${task.tenant_id}` +
        (result.noAddress > 0 ? ` (${result.noAddress} have no address on file)` : "") +
        "; the rest retry next sweep",
    );
  }
}

const HANDLERS: Record<string, TaskHandler> = {
  [TASK_KINDS.membershipExpiryReminder]: handleMembershipExpiryReminder,
  [TASK_KINDS.atRiskBriefs]: handleAtRiskBriefs,
  [TASK_KINDS.waitlistPromotionNotify]: handleWaitlistPromotionNotify,
};

/** Whether a kind has a registered handler. */
export function isKnownTaskKind(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(HANDLERS, kind);
}

/**
 * Run one claimed task.
 *
 * An unrecognised kind throws rather than being skipped. A task in the queue
 * that nothing can run is a bug — usually a handler removed while rows
 * referencing it were still pending — and skipping it silently would leave it
 * claimable forever, re-attempted on every dispatch run, invisible.
 */
export async function runTask(task: TaskRow): Promise<void> {
  const handler = HANDLERS[task.kind];
  if (!handler) {
    throw new Error(`No handler registered for task kind "${task.kind}".`);
  }
  await handler(task);
}

/** How far ahead renewal reminders are enqueued. */
export const EXPIRY_REMINDER_WINDOW_DAYS = 7;

/**
 * Find work that is due and enqueue it, idempotently, for every tenant.
 *
 * Enqueueing is the only step that needs to be cheap and repeatable, and it is
 * both: every insert is `on conflict do nothing` against a dedupe key that
 * encodes the occasion, so running this every hour and running it once a day
 * produce the same set of tasks and the same number of emails. That property is
 * what replaced `notify-membership-expiry.mjs`'s seven-emails-per-renewal bug
 * (see migration 0020).
 *
 * Runs in admin context: it is cross-tenant by nature and has no session.
 */
export async function sweepScheduledWork(
  now: Date = new Date(),
): Promise<{ enqueued: number }> {
  const inputs: EnqueueInput[] = [];

  // --- Renewal reminders: one per plan per billing period. -----------------
  //
  // The dedupe key pairs the plan with the period end, so a plan sitting inside
  // the 7-day window for seven consecutive sweeps enqueues ONE task, while next
  // period's renewal (a different date, therefore a different occasion) is
  // free to enqueue when it comes round.
  const expiring = await withAdminContext(async (c) => {
    const { rows } = await c.query<{
      id: string;
      tenant_id: string;
      current_period_end: string;
    }>(
      `select mp.id, mp.tenant_id, mp.current_period_end
         from member_plans mp
         join member m on m.id = mp.member_id
        where mp.status = 'active'
          and mp.current_period_end is not null
          and mp.current_period_end between now()
              and now() + make_interval(days => $1::integer)
          and m.email is not null`,
      [EXPIRY_REMINDER_WINDOW_DAYS],
    );
    return rows;
  });

  for (const p of expiring) {
    inputs.push({
      tenantId: p.tenant_id,
      kind: TASK_KINDS.membershipExpiryReminder,
      dedupeKey: dedupeKey(p.id, dayStamp(new Date(p.current_period_end))),
      payload: { memberPlanId: p.id },
    });
  }

  // --- Per-tenant weekly / daily sweeps. -----------------------------------
  //
  // One row per gym rather than one per member: the handler does the per-member
  // work in a single query inside the tenant's own context, which keeps the
  // queue small and the connection count low (lib/db.ts caps this process at 3).
  //
  // Both sweeps enqueue only for tenants with WORK TO DO, and that filter is
  // load-bearing rather than an optimisation. The production database carries
  // roughly 154 junk tenants left behind by the RLS test suites, which seed
  // conflicting gyms and never clean up. A bare `select id from gym` would
  // therefore enqueue ~310 tasks a day for gyms that do not exist, against a
  // dispatcher that claims 25 per run on a once-daily cron — so the queue would
  // never drain, and the one real gym's reminders would sit behind a backlog of
  // work for phantoms. Filtering on the existence of a subject makes the sweep
  // proportional to real tenants instead of to accumulated test debris.
  const briefTenants = await withAdminContext(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      // An at-risk brief needs a member who trained and stopped, so a gym with
      // no active members has nothing to file. Cheap: `idx_member_tenant`.
      `select g.id
         from gym g
        where exists (
                select 1 from member m
                 where m.tenant_id = g.id and m.status = 'active'
              )`,
    );
    return rows.map((r) => r.id);
  });

  const waitlistTenants = await withAdminContext(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      // Only gyms that actually have a promotion awaiting an email. This is the
      // query `idx_class_bookings_promotion_unnotified` (migration 0019) was
      // built for, and it normally matches nothing — so the common case
      // enqueues no waitlist task at all rather than one per gym per day.
      `select distinct cb.tenant_id as id
         from class_bookings cb
         join classes cl on cl.id = cb.class_id and cl.tenant_id = cb.tenant_id
        where cb.promoted_at is not null
          and cb.promotion_notified_at is null
          and cb.status = 'booked'
          and cl.starts_at >= now()`,
    );
    return rows.map((r) => r.id);
  });

  const week = isoWeek(now);
  const day = dayStamp(now);

  for (const tenantId of briefTenants) {
    // At-risk briefs are weekly by occasion — see `buildAtRiskBrief`'s dedupe
    // key. Enqueueing them weekly too keeps the queue consistent with the
    // ledger instead of filing a task a day that files nothing.
    inputs.push({
      tenantId,
      kind: TASK_KINDS.atRiskBriefs,
      dedupeKey: dedupeKey(tenantId, week),
    });
  }

  for (const tenantId of waitlistTenants) {
    // The waitlist sweep is a retry net for a path that normally notifies
    // inline, so daily is the right cadence: anything it finds is something that
    // already failed once. A promotion that fails after today's sweep is picked
    // up by tomorrow's, and the class-start filter in `unnotifiedPromotions`
    // stops it chasing sessions that have already happened.
    inputs.push({
      tenantId,
      kind: TASK_KINDS.waitlistPromotionNotify,
      dedupeKey: dedupeKey(tenantId, day),
    });
  }

  const enqueued = await enqueueMany(inputs);
  return { enqueued };
}

export type DispatchSummary = {
  claimed: number;
  succeeded: number;
  failed: number;
  enqueued: number;
};

/**
 * Drain the queue: claim due tasks, run each, record the outcome.
 *
 * Tasks are run SEQUENTIALLY and each outcome is written in its own short
 * transaction. Both are deliberate. Sequential, because this process holds at
 * most 3 pooled connections against a globally-capped pooler, and a parallel
 * drain would compete with live page renders for them — a background sweep must
 * never be the reason a member's portal errors. Short transactions, because the
 * alternative is holding one open across an HTTP call to a mail provider, which
 * turns a slow provider into a held connection and eventually a stuck queue.
 *
 * One task's failure never stops the drain: it is recorded (with backoff, or
 * parked at the ceiling) and the loop continues, so a single poison task cannot
 * starve every other tenant's work.
 */
export async function dispatchDueTasks(options?: {
  limit?: number;
  leaseSeconds?: number;
  sweep?: boolean;
  now?: Date;
}): Promise<DispatchSummary> {
  const sweep = options?.sweep ?? true;
  let enqueued = 0;

  if (sweep) {
    ({ enqueued } = await sweepScheduledWork(options?.now ?? new Date()));
  }

  const claimed = await claimDue({
    limit: options?.limit,
    leaseSeconds: options?.leaseSeconds,
  });

  let succeeded = 0;
  let failed = 0;

  for (const task of claimed) {
    try {
      await runTask(task);
      await completeTask(task.id);
      succeeded += 1;
    } catch (err) {
      failed += 1;
      await failTask(task.id, err, task.attempts, task.max_attempts);
      // Reported, not swallowed: a task that keeps failing is an operational
      // fact, and `last_error` alone is only found by someone already looking.
      await captureException(err, {
        source: "task-dispatch",
        severity: "warning",
        taskId: task.id,
        kind: task.kind,
        tenantId: task.tenant_id,
        attempts: task.attempts,
        maxAttempts: task.max_attempts,
      });
    }
  }

  return { claimed: claimed.length, succeeded, failed, enqueued };
}
