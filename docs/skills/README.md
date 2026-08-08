# Skills — domain rules as versioned prose

A "skill" here is a markdown file stating a rule that governs how derived claims
about members are produced and priced. Prose the code reads, reviewed in pull
requests like code.

The convention is borrowed from [trycompai/crm](https://github.com/trycompai/crm),
whose agent reads four such files (`evidence.md`, `identity-matching.md`,
`data-boundaries.md`, `writing-a-brief.md`) rather than having those rules
scattered through prompt string literals. The reason it is worth copying, even
though we currently run no language model at all, is that the rules exist
regardless of what produces the output:

- **They outlive their implementation.** "Only first-party row observations can
  be priced strong" is a property of our GDPR posture and our safety model, not
  of `lib/suggestions.ts`. Writing it down where it can be cited means a future
  generator inherits it instead of relitigating it.
- **A prompt is not a spec.** The moment a rule lives inside a template string
  it stops being reviewable — nobody diffs a 40-line string, and two copies
  drift. The migration comments in `0020`/`0021` and these files are the spec;
  any future prompt quotes them.
- **They are the review checklist.** When someone proposes a new suggestion
  generator, these are the questions it has to answer.

## The files

| File | Rule it states |
| --- | --- |
| [`evidence.md`](evidence.md) | What counts as evidence, how strength is priced, and why a generator never grades its own confidence. |
| [`writing-a-brief.md`](writing-a-brief.md) | How a brief addresses a trainer: what it must contain, what it must never imply, and the tone constraints that come from this being health-adjacent data. |

## What these are not

Not prompts, and not currently read at runtime by anything — no model is
configured on any deployment (`lib/capabilities.ts` reports `ai` as unconfigured
and expects to stay that way; see [`../AI-IDEAS.md`](../AI-IDEAS.md)). They are
the written form of rules that `lib/suggestions.ts` and `lib/briefs.ts` enforce
in code today, so that the enforcement has a stated reason and the next generator
starts from it.
