/**
 * Program + exercise record shapes and input validation (mvp-program-001/002).
 *
 * Validation is a PURE function (no DB, no env) so it runs in the Server Action
 * before any query and is unit-testable in isolation. The database still
 * enforces the hard invariants (name NOT NULL, sets is integer, the composite
 * (id, tenant_id) FKs, and RLS tenant scoping) — this layer gives the trainer
 * friendly, field-level errors before a round-trip.
 */

/** A program row as read by the staff dashboard (tenant-scoped via RLS). */
export type ProgramRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
};

/** An exercise row, ordered within its program by `position`. */
export type ExerciseRow = {
  id: string;
  program_id: string;
  position: number;
  name: string;
  /** Integer column — nullable when the trainer leaves it blank. */
  sets: number | null;
  /** Free text ("5", "8-12", "to failure"). */
  reps: string | null;
  /** Free text ("90s", "2 min"). */
  rest: string | null;
  notes: string | null;
};

/** Normalised, validated exercise ready to persist (order is array index). */
export type ExerciseInput = {
  name: string;
  sets: number | null;
  reps: string | null;
  rest: string | null;
  notes: string | null;
};

/** Normalised, validated program ready to persist. */
export type ProgramInput = {
  name: string;
  description: string | null;
  exercises: ExerciseInput[];
};

export type ProgramValidationResult =
  | { ok: true; value: ProgramInput }
  | { ok: false; error: string };

// Limits — keep payloads sane; mirror the friendly-error approach in members.ts.
const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;
const EXERCISE_NAME_MAX = 200;
const EXERCISE_TEXT_MAX = 500;
const MAX_EXERCISES = 100;
const SETS_MAX = 100;

/** Trim a value to a string, or "" when it is not a usable string. */
function asTrimmed(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** A blank string becomes null (these columns are nullable). */
function nullableText(v: unknown): string | null {
  const s = asTrimmed(v);
  return s.length > 0 ? s : null;
}

/**
 * Validate + normalise raw program values into a `ProgramInput`.
 *
 * Rules:
 *   - name is REQUIRED (matches the NOT NULL column) and length-capped.
 *   - description is optional free text.
 *   - exercises is an array (may be empty — a draft program is allowed). Each
 *     exercise needs a name; `sets` (if given) must be a whole number 0..100;
 *     reps/rest/notes are optional free text. Array order IS the saved order.
 */
export function validateProgramInput(raw: {
  name?: unknown;
  description?: unknown;
  exercises?: unknown;
}): ProgramValidationResult {
  const name = asTrimmed(raw.name);
  if (!name) {
    return { ok: false, error: "Program name is required." };
  }
  if (name.length > NAME_MAX) {
    return {
      ok: false,
      error: `Program name is too long (max ${NAME_MAX} characters).`,
    };
  }

  const description = nullableText(raw.description);
  if (description && description.length > DESCRIPTION_MAX) {
    return {
      ok: false,
      error: `Description is too long (max ${DESCRIPTION_MAX} characters).`,
    };
  }

  if (raw.exercises !== undefined && !Array.isArray(raw.exercises)) {
    return { ok: false, error: "Exercises must be a list." };
  }
  const rawExercises = Array.isArray(raw.exercises) ? raw.exercises : [];
  if (rawExercises.length > MAX_EXERCISES) {
    return {
      ok: false,
      error: `A program can have at most ${MAX_EXERCISES} exercises.`,
    };
  }

  const exercises: ExerciseInput[] = [];
  for (let i = 0; i < rawExercises.length; i++) {
    const e = rawExercises[i] as Record<string, unknown> | null;
    const position = i + 1; // 1-based for human-readable errors

    const exName = asTrimmed(e?.name);
    if (!exName) {
      return { ok: false, error: `Exercise ${position} needs a name.` };
    }
    if (exName.length > EXERCISE_NAME_MAX) {
      return {
        ok: false,
        error: `Exercise ${position} name is too long (max ${EXERCISE_NAME_MAX} characters).`,
      };
    }

    let sets: number | null = null;
    const setsRaw = e?.sets;
    const setsStr =
      typeof setsRaw === "number" ? String(setsRaw) : asTrimmed(setsRaw);
    if (setsStr !== "") {
      const n = Number(setsStr);
      if (!Number.isInteger(n) || n < 0 || n > SETS_MAX) {
        return {
          ok: false,
          error: `Exercise ${position}: sets must be a whole number between 0 and ${SETS_MAX}.`,
        };
      }
      sets = n;
    }

    const reps = nullableText(e?.reps);
    const rest = nullableText(e?.rest);
    const notes = nullableText(e?.notes);
    for (const [label, val] of [
      ["reps", reps],
      ["rest", rest],
      ["notes", notes],
    ] as const) {
      if (val && val.length > EXERCISE_TEXT_MAX) {
        return {
          ok: false,
          error: `Exercise ${position}: ${label} is too long (max ${EXERCISE_TEXT_MAX} characters).`,
        };
      }
    }

    exercises.push({ name: exName, sets, reps, rest, notes });
  }

  return { ok: true, value: { name, description, exercises } };
}
