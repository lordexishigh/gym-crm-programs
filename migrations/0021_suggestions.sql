-- 0021_suggestions.sql
--
-- The suggestion ledger: a place for derived, non-authoritative claims about a
-- member or a program to wait for a trainer's decision, carrying the evidence
-- they were derived from.
--
-- Why this exists before any generator does. Everything we are likely to add
-- next — at-risk flags, progression proposals, drafted programs — produces
-- claims that are USUALLY right. The tempting shape is to write them straight
-- onto the record and let the trainer correct the mistakes. That shape fails
-- badly in this specific product for two reasons:
--
--   1. The records are health-adjacent. A program, an injury note and an
--      adherence figure drive what a member is told to lift. A wrong derived
--      value silently overwriting a trainer's judgement is a safety problem,
--      not a data-quality one.
--   2. We are an EU/GDPR product processing this data on a lawful basis that
--      assumes a human decides. "The system inferred it" is not an audit
--      trail. `reviewed_by`/`reviewed_at` are.
--
-- So derived claims land HERE, and a trainer promotes them. The ledger prices
-- evidence rather than asking the generator how confident it feels:
-- `strength` is set from what was actually observed (how many logged sessions,
-- over what window), and `ledgerDisposition` (lib/suggestions.ts) maps it to
-- either "may be applied" or "must be reviewed". A generator cannot mark its
-- own output strong by asserting confidence — it can only report observations,
-- and the ledger prices them. That distinction is the whole point: a
-- self-graded confidence score is a number a generator can always make look
-- good, and it will.
--
-- `evidence` is a jsonb array of observations, each naming the source it came
-- from (`workout_log.session-count`, `member_plans.period-end`) and, where
-- there is one, the row id. It is not decoration: it is what the trainer reads
-- to decide, and what makes a suggestion auditable after the fact. A suggestion
-- with no evidence is not a suggestion, it is a guess — hence the CHECK below.
--
-- Subject references are two nullable, tenant-consistent FKs rather than one
-- polymorphic (subject_type, subject_id) pair. Polymorphic columns cannot be
-- foreign keys, and that costs two things we need: referential integrity, and
-- ON DELETE CASCADE. The cascade is the GDPR-relevant part — erasing a member
-- (0004/0006) must take every derived claim about them with it, and it now does
-- so by construction rather than by remembering to add this table to the
-- erasure path.

create table if not exists suggestions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references gym(id) on delete cascade,
  -- Which generator produced this and what it is proposing, e.g.
  -- 'at_risk_brief', 'progression', 'program_draft'. Application-registered for
  -- the same reason `tasks.kind` is (see 0020).
  kind          text not null,
  -- Exactly one subject. Tenant-consistent composite FKs, matching the pattern
  -- used throughout (0016's check_ins_member_fk, and so on).
  member_id     uuid,
  program_id    uuid,
  -- One-line statement of the claim, written for a trainer scanning a list.
  headline      text not null check (length(trim(headline)) > 0),
  -- The proposal itself, shaped per `kind` (a drafted program body, a set of
  -- proposed loads). Empty for suggestions that are purely informational.
  detail        jsonb not null default '{}'::jsonb,
  -- Array of observations. See the header; must be non-empty.
  evidence      jsonb not null default '[]'::jsonb,
  -- Priced by the ledger from the observations, never self-reported.
  strength      text not null check (strength in ('strong', 'weak')),
  status        text not null default 'pending'
                  check (status in ('pending', 'accepted', 'dismissed', 'superseded')),
  -- What generated it, versioned: 'rules:at-risk-v1', 'llm:claude-opus-5'.
  -- Versioned because a suggestion accepted last month was produced by
  -- different logic than today's, and an audit needs to know which.
  source        text not null,
  -- The occasion, as in tasks.dedupe_key (0020): re-running a generator must
  -- not pile up duplicate pending suggestions about the same thing.
  dedupe_key    text not null,
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  review_note   text,
  created_at    timestamptz not null default now(),

  constraint suggestions_one_subject check (
    (member_id is not null and program_id is null)
    or (member_id is null and program_id is not null)
  ),
  -- Evidence is mandatory. jsonb_array_length also rejects a non-array, so a
  -- generator that writes an object here fails loudly at insert.
  constraint suggestions_has_evidence check (
    jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) > 0
  ),
  -- A reviewed suggestion records WHO reviewed it. Enforced here so the audit
  -- trail cannot be half-written by a buggy action.
  constraint suggestions_review_complete check (
    (status in ('pending', 'superseded'))
    or (reviewed_at is not null)
  ),
  constraint suggestions_member_fk
    foreign key (member_id, tenant_id) references member (id, tenant_id) on delete cascade,
  constraint suggestions_program_fk
    foreign key (program_id, tenant_id) references program (id, tenant_id) on delete cascade
);

-- One pending suggestion per occasion per subject.
create unique index if not exists idx_suggestions_dedupe
  on suggestions (tenant_id, kind, dedupe_key);

-- The review queue: pending work for this gym, newest first. Partial, so it
-- stays small as reviewed history accumulates.
create index if not exists idx_suggestions_pending
  on suggestions (tenant_id, created_at desc)
  where status = 'pending';

-- "What has been suggested about this member?" on the member detail page.
create index if not exists idx_suggestions_member
  on suggestions (tenant_id, member_id, created_at desc)
  where member_id is not null;

alter table suggestions enable row level security;
alter table suggestions force  row level security;

-- Staff read, and staff review (the UPDATE that sets accepted/dismissed).
--
-- Staff INSERT is allowed too, unlike `tasks`. The asymmetry is deliberate: a
-- trainer clicking "draft a program for this member" is an interactive,
-- tenant-scoped write, and routing it through the admin path to avoid an
-- INSERT policy would weaken the isolation story for no gain — a trainer can
-- already write member and program rows directly, so a forged suggestion grants
-- them nothing they lack. `tasks` is different because its payloads name a
-- handler this server will later execute.
--
-- The WITH CHECK pins tenant_id on both INSERT and UPDATE, so no session can
-- create or move a suggestion into another gym.
drop policy if exists suggestions_staff_all on suggestions;
create policy suggestions_staff_all on suggestions
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

-- No member policy: RLS denies members every row. These are internal
-- deliberations about a member, not content for them — a pending "this member
-- is disengaging" brief shown to the member would be both wrong and unkind.

grant select, insert, update, delete on suggestions to app_user;

comment on table suggestions is
  'Ledger of derived, non-authoritative claims about a member or program, each carrying the observations it came from, awaiting a trainer decision. Strength is priced from evidence by lib/suggestions.ts, never self-reported by the generator.';
comment on column suggestions.evidence is
  'Non-empty jsonb array of observations: {source, observed, ref?, at?}. What the trainer reads to decide, and the audit trail afterwards.';
comment on column suggestions.strength is
  'Priced from the observations by ledgerDisposition (lib/suggestions.ts). Weak suggestions may never be auto-applied.';
comment on column suggestions.source is
  'Versioned identity of the generator (rules:at-risk-v1, llm:claude-opus-5), so an audit can tell which logic produced an accepted suggestion.';
