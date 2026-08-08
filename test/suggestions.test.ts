import { describe, expect, it } from "vitest";
import {
  isFirstPartySource,
  ledgerDisposition,
  priceEvidence,
  validateSuggestionInput,
  type Observation,
} from "../lib/suggestions";

/**
 * The evidence ledger's pricing rules (migration 0021).
 *
 * The safety property under test: a generator cannot promote its own output. No
 * amount of model-produced evidence can ever be priced 'strong', so adding an
 * LLM generator later can only add things for a trainer to REVIEW — it can never
 * widen what gets applied without one. That ceiling is worth a test that fails
 * loudly if anyone relaxes it.
 */

const rowObservation = (i: number): Observation => ({
  source: "workout_log.window-count",
  observed: `observation ${i}`,
  ref: `11111111-1111-1111-1111-11111111111${i}`,
});

describe("isFirstPartySource", () => {
  it("accepts <table>.<aspect>", () => {
    expect(isFirstPartySource("workout_log.last-session")).toBe(true);
    expect(isFirstPartySource("member_plans.period-end")).toBe(true);
    expect(isFirstPartySource("program_assignment.none")).toBe(true);
  });

  it("rejects model and third-party prefixes", () => {
    expect(isFirstPartySource("llm:claude-opus-5.program-draft")).toBe(false);
    expect(isFirstPartySource("external:some-api.company")).toBe(false);
    expect(isFirstPartySource("user-supplied:form.note")).toBe(false);
  });

  it("rejects anything that is not a dotted table reference", () => {
    expect(isFirstPartySource("workout_log")).toBe(false);
    expect(isFirstPartySource("Workout_Log.count")).toBe(false);
    expect(isFirstPartySource("")).toBe(false);
  });
});

describe("priceEvidence", () => {
  it("prices two anchored first-party observations as strong", () => {
    expect(priceEvidence([rowObservation(1), rowObservation(2)])).toBe("strong");
  });

  it("prices a single observation as weak", () => {
    // One number is a coincidence; two agreeing facts are a pattern.
    expect(priceEvidence([rowObservation(1)])).toBe("weak");
  });

  it("prices unanchored observations as weak", () => {
    // Nothing a trainer can open and check.
    const noRefs: Observation[] = [
      { source: "workout_log.window-count", observed: "a" },
      { source: "member_plans.period-end", observed: "b" },
    ];
    expect(priceEvidence(noRefs)).toBe("weak");
  });

  it("lets one model-generated observation drag the whole set to weak", () => {
    // The claim now rests partly on generated text, so the whole suggestion
    // does. This is the rule that keeps the ceiling in place.
    const mixed: Observation[] = [
      rowObservation(1),
      rowObservation(2),
      { source: "llm:claude-opus-5.summary", observed: "looks disengaged" },
    ];
    expect(priceEvidence(mixed)).toBe("weak");
  });

  it("cannot be talked into strong by model evidence alone", () => {
    const allModel: Observation[] = Array.from({ length: 20 }, (_, i) => ({
      source: "llm:claude-opus-5.summary",
      observed: `reason ${i}`,
      ref: `22222222-2222-2222-2222-2222222222${String(i).padStart(2, "0")}`,
    }));
    expect(priceEvidence(allModel)).toBe("weak");
  });

  it("prices an empty set as weak", () => {
    expect(priceEvidence([])).toBe("weak");
  });
});

describe("ledgerDisposition", () => {
  it("permits application only for strong evidence", () => {
    expect(ledgerDisposition("strong")).toBe("apply");
    expect(ledgerDisposition("weak")).toBe("review");
  });
});

describe("validateSuggestionInput", () => {
  const valid = {
    kind: "at_risk_brief",
    memberId: "33333333-3333-3333-3333-333333333333",
    headline: "Maria has not trained in 24 days.",
    observations: [rowObservation(1), rowObservation(2)],
    source: "rules:at-risk-v1",
    dedupeKey: "member:2026-W31",
  };

  it("accepts a well-formed suggestion", () => {
    expect(validateSuggestionInput(valid)).toEqual({ ok: true });
  });

  it("requires exactly one subject", () => {
    const neither = validateSuggestionInput({ ...valid, memberId: null });
    expect(neither.ok).toBe(false);

    const both = validateSuggestionInput({
      ...valid,
      programId: "44444444-4444-4444-4444-444444444444",
    });
    expect(both.ok).toBe(false);
    if (!both.ok) {
      expect(both.errors).toContain(
        "Exactly one of memberId or programId is required.",
      );
    }
  });

  it("requires evidence", () => {
    const result = validateSuggestionInput({ ...valid, observations: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("At least one observation is required.");
    }
  });

  it("reports every problem at once rather than the first", () => {
    const result = validateSuggestionInput({
      kind: "",
      headline: "  ",
      observations: [],
      source: "",
      dedupeKey: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(4);
  });

  it("rejects an observation with no source or no statement", () => {
    const result = validateSuggestionInput({
      ...valid,
      observations: [{ source: "", observed: "" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("observation 0: source is required.");
      expect(result.errors).toContain("observation 0: observed is required.");
    }
  });
});
