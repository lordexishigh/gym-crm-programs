# Evidence

Enforced by `priceEvidence` and `ledgerDisposition` in
[`lib/suggestions.ts`](../../lib/suggestions.ts); pinned by
[`test/suggestions.test.ts`](../../test/suggestions.test.ts).

## Report observations, not conclusions about yourself

A generator's job is to report what it observed and where it came from. It does
not report how confident it is.

There is no confidence score anywhere in this system, and there will not be one.
A generator asked to grade its own certainty will produce a number, and that
number will be wrong in the direction that makes the generator look useful —
which is precisely the direction that does damage, because the one decision the
number would drive ("is this safe to apply without a human?") is the decision
where optimism is most expensive. Strength is therefore priced by the ledger from
what was actually observed, and `createSuggestion` deliberately takes no
`strength` argument at all: the caller cannot supply one.

## The shape of an observation

```ts
{
  source: "workout_log.last-session",              // stable id, not prose
  observed: "Last logged session on 3 July 2026.", // the fact, for a trainer
  ref: "…uuid…",                                   // the row it came from
  at: "2026-07-03T18:30:00Z"                       // when the thing happened
}
```

`source` is an identifier, not a sentence: `<table>.<aspect>` for something read
from our own rows, and a prefix (`llm:`, `external:`, `user-supplied:`) for
anything else. It is what pricing reads, and what an audit six months later uses
to establish whether a claim was grounded or invented.

## Pricing

**Strong** requires all three:

1. every source is a first-party row observation;
2. at least two independent observations — one number is a coincidence, two
   agreeing facts are a pattern;
3. at least one observation carries a `ref`, so the claim is anchored to
   something a trainer can open and check.

**Everything else is weak.** Weak is not an insult. Most useful suggestions are
weak, and weak simply means a human decides.

## The ceiling

`llm:`, `external:` and `user-supplied:` sources can **never** be priced strong,
whatever else is true, and a single such observation in an otherwise solid set
drags the whole suggestion down to weak — correct, because the claim now rests
partly on it.

A model's output is not an observation of anything. It is a plausible sentence
*about* observations, and its plausibility is uncorrelated with its accuracy in
exactly the cases that matter. External APIs are excluded for a different reason:
we cannot audit their provenance, so we cannot stand behind them as observations
of fact.

This is the safety property that makes it acceptable to add a model generator
later: doing so can only add things to review. It cannot widen what gets applied
without a human, because it cannot reach the strength that permits that.

## Strength is not permission

`ledgerDisposition` maps strength to `"apply"` or `"review"`, and it governs
suggestions that propose a **write**. A brief proposes none, so a strong brief is
a statement that its numbers can be trusted as written — not a licence to act
unattended. Briefs always go to the queue, and a trainer always decides whether
to reach out.

## A suggestion with no evidence is not a suggestion

It is a guess. The `suggestions_has_evidence` CHECK in migration 0021 rejects it
at the database level, not just in application validation.
