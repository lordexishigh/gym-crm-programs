# Writing a brief

Enforced by `buildAtRiskBrief` in [`lib/briefs.ts`](../../lib/briefs.ts); pinned
by [`test/briefs.test.ts`](../../test/briefs.test.ts).

A brief is one or two sentences addressed to a trainer about one member, plus the
observations behind it. It exists because a badge is not actionable: the roster
already flags who went quiet, and a trainer still had to open the profile and
reconstruct the situation by hand for every flagged member.

## Who gets one

Only a member who **trained and then stopped** — sessions logged historically,
none inside the adherence window. This mirrors `memberEngagementLevel`'s
`"at-risk"` and must keep mirroring it, or the roster and the review queue will
disagree about who is at risk and a trainer will stop trusting both.

Explicitly **not**:

- a member logging inside the window — they are training; there is nothing to
  raise;
- a member who has **never** logged. That is an onboarding problem, not churn.
  Filing them here would bury the members a conversation can still save under
  everyone who was ever added and never came in.

## What it must contain

1. **How long.** A whole number of days since the last session, floored, and
   never negative — a clock skew between app and database must not produce
   "trained −2 days ago".
2. **Since when.** The actual date, formatted the way the rest of the product
   formats dates (`3 July 2026`).
3. **Against what.** The assigned program, or the explicit statement that there
   is none. These are two different conversations — "you have a program and
   stopped using it" versus "you stopped, and nobody has given you anything to
   come back to" — and the trainer needs to know which one they are having before
   they dial.

## What it must never do

- **Never diagnose.** Report the gap; do not explain it. We know a member stopped
  logging. We do not know they are injured, demotivated, on holiday, or training
  elsewhere, and a brief that guesses hands the trainer a false premise to open
  the conversation with.
- **Never address the member.** A brief is internal. Members cannot see
  suggestions (there is no member RLS policy on the table, by design) — a pending
  "this member is disengaging" note shown to the member would be both wrong and
  unkind.
- **Never imply an action was taken.** The brief raises; the trainer decides. The
  review control says "Mark as actioned", not "Accept", because nothing is applied
  to any record.

## Determinism

Identical facts must produce identical text. The brief is written to an
audit-relevant ledger and read as the basis for contacting someone about their
health data, so it is a template over arithmetic, not generated prose. If a model
is ever involved here, it may only affect phrasing, which is the one part that
does not matter — and its involvement would drop the suggestion to weak (see
[`evidence.md`](evidence.md)).

## Cadence

One brief per member per ISO week. A daily generator would otherwise raise a
fresh brief every morning for the same quiet member and bury the trainer in
duplicates; the week-scoped dedupe key still re-raises if the member stays quiet,
so the signal does not disappear either.
