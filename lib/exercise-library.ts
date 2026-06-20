/**
 * Per-gym exercise library record shapes + input validation
 * (alpha-exercise-library-001).
 *
 * A library exercise is a standalone, reusable catalog entry (it has the same
 * fields as a program's exercise, but no program_id and no position — order is
 * meaningless in a catalog). Validation is a PURE function — no DB, no env — so
 * it runs in the Server Action before any query and is unit-testable, exactly
 * like `validateProgramInput` in lib/programs.ts. Limits mirror the per-exercise
 * rules there so a library exercise inserted into a program always re-validates.
 */

/** A library exercise as read by the staff dashboard (tenant-scoped via RLS). */
export type LibraryExerciseRow = {
  id: string;
  name: string;
  sets: number | null;
  reps: string | null;
  rest: string | null;
  notes: string | null;
};

/** Normalised, validated library exercise ready to persist. */
export type LibraryExerciseInput = {
  name: string;
  sets: number | null;
  reps: string | null;
  rest: string | null;
  notes: string | null;
};

export type LibraryExerciseValidationResult =
  | { ok: true; value: LibraryExerciseInput }
  | { ok: false; error: string };

// Limits — mirror the per-exercise limits in lib/programs.ts.
const NAME_MAX = 200;
const TEXT_MAX = 500;
const SETS_MAX = 100;

function asTrimmed(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function nullableText(v: unknown): string | null {
  const s = asTrimmed(v);
  return s.length > 0 ? s : null;
}

/**
 * Validate + normalise raw library-exercise values.
 *
 * Rules (identical to a program's exercise): name is REQUIRED and length-capped;
 * `sets` (if given) must be a whole number 0..100; reps/rest/notes are optional
 * free text.
 */
export function validateLibraryExerciseInput(raw: {
  name?: unknown;
  sets?: unknown;
  reps?: unknown;
  rest?: unknown;
  notes?: unknown;
}): LibraryExerciseValidationResult {
  const name = asTrimmed(raw.name);
  if (!name) {
    return { ok: false, error: "Exercise name is required." };
  }
  if (name.length > NAME_MAX) {
    return {
      ok: false,
      error: `Exercise name is too long (max ${NAME_MAX} characters).`,
    };
  }

  let sets: number | null = null;
  const setsRaw = raw.sets;
  const setsStr =
    typeof setsRaw === "number" ? String(setsRaw) : asTrimmed(setsRaw);
  if (setsStr !== "") {
    const n = Number(setsStr);
    if (!Number.isInteger(n) || n < 0 || n > SETS_MAX) {
      return {
        ok: false,
        error: `Sets must be a whole number between 0 and ${SETS_MAX}.`,
      };
    }
    sets = n;
  }

  const reps = nullableText(raw.reps);
  const rest = nullableText(raw.rest);
  const notes = nullableText(raw.notes);
  for (const [label, val] of [
    ["Reps", reps],
    ["Rest", rest],
    ["Notes", notes],
  ] as const) {
    if (val && val.length > TEXT_MAX) {
      return {
        ok: false,
        error: `${label} is too long (max ${TEXT_MAX} characters).`,
      };
    }
  }

  return { ok: true, value: { name, sets, reps, rest, notes } };
}
