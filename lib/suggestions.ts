import { withTenantContext, type Identity } from "@/lib/db";

/**
 * The suggestion ledger (migration 0021): derived claims about a member or
 * program, each carrying its evidence, waiting for a trainer's decision.
 *
 * The rule this module exists to enforce is in `priceEvidence`: a generator
 * reports OBSERVATIONS and the ledger prices them. No generator gets to say how
 * confident it is, because a confidence score is a number the producer can
 * always make flattering, and the one place that matters — "is this safe to
 * apply without a human?" — is exactly where a flattering number does damage.
 *
 * The pricing rule is deliberately blunt and mechanical (see `priceEvidence`):
 * first-party observations of our own rows can be strong; anything a language
 * model or third-party API produced is weak by construction, forever. That
 * ceiling is the safety property. It means adding an LLM generator later cannot
 * widen what gets applied without review — it can only add things to review.
 */

/**
 * One thing that was observed, with where it came from.
 *
 * `source` is a stable identifier, not prose: `workout_log.session-count`,
 * `member_plans.period-end`, `llm:claude-opus-5.program-draft`. It is what
 * `priceEvidence` reads, and what an audit six months later uses to work out
 * whether a suggestion was grounded or invented.
 */
export type Observation = {
  /** Stable source id — `<table>.<aspect>` for first-party, prefixed otherwise. */
  source: string;
  /** The fact, phrased for a trainer to read. */
  observed: string;
  /** Row id the observation came from, when it came from one. */
  ref?: string;
  /** When the observed thing happened (ISO), when that is meaningful. */
  at?: string;
};

export type SuggestionStrength = "strong" | "weak";
export type SuggestionStatus =
  | "pending"
  | "accepted"
  | "dismissed"
  | "superseded";

/**
 * What the ledger permits for a given strength.
 *
 *   "apply"  — well-grounded enough that a caller MAY write it directly (it
 *              still records a suggestion row, so the write is auditable).
 *   "review" — must sit in the queue until a trainer decides. No code path may
 *              auto-apply this.
 *
 * Kept as a function rather than inlined comparisons so there is exactly one
 * place that decides, and one place a test can pin.
 */
export function ledgerDisposition(
  strength: SuggestionStrength,
): "apply" | "review" {
  return strength === "strong" ? "apply" : "review";
}

/**
 * Sources that can never be strong, whatever they claim.
 *
 * A model's output is not an observation of anything — it is a plausible
 * sentence about observations, and its plausibility is uncorrelated with its
 * accuracy in exactly the cases that matter. An external API is excluded for a
 * different reason: we cannot audit its provenance, so we cannot stand behind
 * it as an observation of fact.
 */
const NEVER_STRONG_PREFIXES = ["llm:", "external:", "user-supplied:"] as const;

/** `<table>.<aspect>` — an observation read from one of our own rows. */
const FIRST_PARTY_SOURCE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9-]*$/;

/** Whether a single source identifier denotes a first-party row observation. */
export function isFirstPartySource(source: string): boolean {
  if (NEVER_STRONG_PREFIXES.some((p) => source.startsWith(p))) return false;
  return FIRST_PARTY_SOURCE.test(source);
}

/**
 * Price a set of observations into a strength.
 *
 * Strong requires all three of:
 *
 *   - every source is a first-party row observation (so one model-generated
 *     observation in an otherwise solid set drags the whole suggestion down to
 *     weak — correct, because the claim now rests partly on it);
 *   - at least two independent observations, since a single number is a
 *     coincidence and two agreeing facts are a pattern;
 *   - at least one observation pointing at a concrete row (`ref`), so the claim
 *     is anchored to something a trainer can open and check.
 *
 * Everything else is weak. Weak is not an insult — most useful suggestions are
 * weak, and weak simply means a human decides.
 */
export function priceEvidence(observations: Observation[]): SuggestionStrength {
  if (observations.length < 2) return "weak";
  if (!observations.every((o) => isFirstPartySource(o.source))) return "weak";
  if (!observations.some((o) => Boolean(o.ref))) return "weak";
  return "strong";
}

export type SuggestionInput = {
  kind: string;
  /** Exactly one of these, matching the `suggestions_one_subject` CHECK. */
  memberId?: string | null;
  programId?: string | null;
  headline: string;
  detail?: Record<string, unknown>;
  observations: Observation[];
  /** Versioned generator id, e.g. `rules:at-risk-v1`. */
  source: string;
  /** The occasion — same discipline as `dedupeKey` in lib/tasks.ts. */
  dedupeKey: string;
};

export type SuggestionValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

/**
 * Validate a suggestion before it reaches the database.
 *
 * The DB has CHECK constraints for the same invariants, and they are the real
 * guarantee — this exists so a caller gets a list of what is wrong instead of a
 * single opaque constraint violation, and so the rules are unit-testable
 * without a database (which, locally, there isn't one).
 */
export function validateSuggestionInput(
  input: SuggestionInput,
): SuggestionValidationResult {
  const errors: string[] = [];

  if (!input.kind.trim()) errors.push("kind is required.");
  if (!input.source.trim()) errors.push("source is required.");
  if (!input.dedupeKey.trim()) errors.push("dedupeKey is required.");
  if (!input.headline.trim()) errors.push("headline is required.");

  const hasMember = Boolean(input.memberId);
  const hasProgram = Boolean(input.programId);
  if (hasMember === hasProgram) {
    errors.push("Exactly one of memberId or programId is required.");
  }

  if (input.observations.length === 0) {
    errors.push("At least one observation is required.");
  }
  input.observations.forEach((o, i) => {
    if (!o.source.trim()) errors.push(`observation ${i}: source is required.`);
    if (!o.observed.trim()) {
      errors.push(`observation ${i}: observed is required.`);
    }
  });

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export type SuggestionRow = {
  id: string;
  kind: string;
  member_id: string | null;
  program_id: string | null;
  headline: string;
  detail: Record<string, unknown>;
  evidence: Observation[];
  strength: SuggestionStrength;
  status: SuggestionStatus;
  source: string;
  dedupe_key: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
};

/** Row shape returned to the review queue, joined to the subject's name. */
export type PendingSuggestionRow = SuggestionRow & {
  member_name: string | null;
  program_name: string | null;
};

/**
 * Record a suggestion, pricing its evidence on the way in.
 *
 * Returns the created row, or null when an identical occasion is already in the
 * ledger — re-running a generator is therefore free and does not pile duplicate
 * pending items onto a trainer's queue. That is the same `on conflict do
 * nothing` discipline as `enqueue` in lib/tasks.ts, and for the same reason: the
 * caller should not have to remember.
 *
 * Staff-only by RLS (`suggestions_staff_all`). The explicit role check is here
 * so a mistaken member-session call fails with a legible error rather than an
 * empty result that reads like "nothing to suggest".
 */
export async function createSuggestion(
  identity: Identity,
  input: SuggestionInput,
): Promise<SuggestionRow | null> {
  if (identity.role !== "staff") {
    throw new Error("createSuggestion requires a staff identity.");
  }
  const validation = validateSuggestionInput(input);
  if (!validation.ok) {
    throw new Error(
      `Invalid suggestion: ${validation.errors.join(" ")}`,
    );
  }

  const strength = priceEvidence(input.observations);

  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<SuggestionRow>(
      `insert into suggestions
         (tenant_id, kind, member_id, program_id, headline, detail, evidence,
          strength, source, dedupe_key)
       values (app_current_tenant(), $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
       on conflict (tenant_id, kind, dedupe_key) do nothing
       returning id, kind, member_id, program_id, headline, detail, evidence,
                 strength, status, source, dedupe_key, reviewed_by, reviewed_at,
                 review_note, created_at`,
      [
        input.kind,
        input.memberId ?? null,
        input.programId ?? null,
        input.headline,
        JSON.stringify(input.detail ?? {}),
        JSON.stringify(input.observations),
        strength,
        input.source,
        input.dedupeKey,
      ],
    );
    return rows[0] ?? null;
  });
}

/**
 * The trainer's review queue for their own gym.
 *
 * Ordered strong-first, then newest: a strong suggestion is the one most likely
 * to be accepted unchanged, so it belongs where the reviewer looks first.
 */
export async function listPendingSuggestions(
  identity: Identity,
  limit = 50,
): Promise<PendingSuggestionRow[]> {
  const capped = Math.min(Math.max(1, Math.floor(limit)), 200);
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<PendingSuggestionRow>(
      `select s.id, s.kind, s.member_id, s.program_id, s.headline, s.detail,
              s.evidence, s.strength, s.status, s.source, s.dedupe_key,
              s.reviewed_by, s.reviewed_at, s.review_note, s.created_at,
              m.full_name as member_name,
              p.name      as program_name
         from suggestions s
         left join member  m on m.id = s.member_id
         left join program p on p.id = s.program_id
        where s.status = 'pending'
          -- An erased member (beta-gdpr-002) drops out of the review queue: the
          -- brief names a person the gym may no longer hold data about, and
          -- "call Erased member, they went quiet" is not reviewable work. The
          -- row survives (the erasure scrubs only its headline) so the ledger of
          -- what was suggested stays intact. LEFT JOIN, so a gym-level
          -- suggestion with no member_id must still pass.
          and (s.member_id is null or m.erased_at is null)
        order by (s.strength = 'strong') desc, s.created_at desc
        limit $1`,
      [capped],
    );
    return rows;
  });
}

/** Every suggestion ever raised about one member, newest first. */
export async function suggestionsForMember(
  identity: Identity,
  memberId: string,
  limit = 20,
): Promise<SuggestionRow[]> {
  const capped = Math.min(Math.max(1, Math.floor(limit)), 100);
  return withTenantContext(identity, async (c) => {
    const { rows } = await c.query<SuggestionRow>(
      `select id, kind, member_id, program_id, headline, detail, evidence,
              strength, status, source, dedupe_key, reviewed_by, reviewed_at,
              review_note, created_at
         from suggestions
        where member_id = $1
        order by created_at desc
        limit $2`,
      [memberId, capped],
    );
    return rows;
  });
}

/**
 * Record a trainer's decision.
 *
 * `reviewed_by` comes from the verified session identity, never from the form —
 * the audit trail is only worth having if the browser cannot write it. The
 * `status = 'pending'` guard makes a double-submit (or two trainers reviewing
 * the same item) a no-op on the second call rather than silently overwriting the
 * first decision and its author.
 *
 * Returns whether this call was the one that decided it.
 */
export async function reviewSuggestion(
  identity: Identity,
  id: string,
  decision: "accepted" | "dismissed",
  note?: string,
): Promise<boolean> {
  if (identity.role !== "staff") {
    throw new Error("reviewSuggestion requires a staff identity.");
  }
  return withTenantContext(identity, async (c) => {
    const { rowCount } = await c.query(
      `update suggestions
          set status = $2,
              reviewed_by = nullif($3, '')::uuid,
              reviewed_at = now(),
              review_note = nullif($4, '')
        where id = $1 and status = 'pending'`,
      [id, decision, identity.userId ?? "", note ?? ""],
    );
    return (rowCount ?? 0) > 0;
  });
}

/**
 * Retire the pending suggestions of one kind about one subject.
 *
 * Used when a generator's input has changed enough that its earlier output is
 * stale (a member started training again, so last week's at-risk brief is no
 * longer true). 'superseded' rather than deleted: the row is the record that we
 * once thought this, which is the point of a ledger.
 */
export async function supersedePending(
  identity: Identity,
  kind: string,
  memberId: string,
): Promise<number> {
  return withTenantContext(identity, async (c) => {
    const { rowCount } = await c.query(
      `update suggestions
          set status = 'superseded'
        where kind = $1 and member_id = $2 and status = 'pending'`,
      [kind, memberId],
    );
    return rowCount ?? 0;
  });
}
