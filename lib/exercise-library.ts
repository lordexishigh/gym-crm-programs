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

/**
 * A library exercise as read by the program builder + program pages
 * (tenant-scoped via RLS). This is the MINIMAL shape those consumers need —
 * the richer reference content lives on `LibraryExerciseDetail` so adding it
 * never changes what ProgramBuilder reads.
 */
export type LibraryExerciseRow = {
  id: string;
  name: string;
  sets: number | null;
  reps: string | null;
  rest: string | null;
  notes: string | null;
};

/**
 * A library exercise with its full reference content, as shown on the exercise
 * library page (alpha-exercise-library-003): an image, how-to instructions,
 * form/safety guidelines, coaching tips, a category, and whether it is part of
 * the built-in starter catalog.
 */
export type LibraryExerciseDetail = LibraryExerciseRow & {
  category: string | null;
  imageUrl: string | null;
  instructions: string | null;
  guidelines: string | null;
  tips: string | null;
  isSeeded: boolean;
};

/** Normalised, validated library exercise ready to persist. */
export type LibraryExerciseInput = {
  name: string;
  sets: number | null;
  reps: string | null;
  rest: string | null;
  notes: string | null;
  category: string | null;
  imageUrl: string | null;
  instructions: string | null;
  guidelines: string | null;
  tips: string | null;
};

export type LibraryExerciseValidationResult =
  | { ok: true; value: LibraryExerciseInput }
  | { ok: false; error: string };

// Limits — the short fields mirror the per-exercise limits in lib/programs.ts;
// the teaching-content fields are allowed to be longer paragraphs.
const NAME_MAX = 200;
const TEXT_MAX = 500;
const CATEGORY_MAX = 80;
const URL_MAX = 1000;
const CONTENT_MAX = 4000;
const SETS_MAX = 100;

function asTrimmed(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function nullableText(v: unknown): string | null {
  const s = asTrimmed(v);
  return s.length > 0 ? s : null;
}

/** A plain http(s) URL, or null if blank. Returns false when present-but-bad. */
function parseOptionalUrl(v: unknown): string | null | false {
  const s = asTrimmed(v);
  if (!s) return null;
  if (s.length > URL_MAX) return false;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? s : false;
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
  category?: unknown;
  imageUrl?: unknown;
  instructions?: unknown;
  guidelines?: unknown;
  tips?: unknown;
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
  const category = nullableText(raw.category);
  for (const [label, val, max] of [
    ["Reps", reps, TEXT_MAX],
    ["Rest", rest, TEXT_MAX],
    ["Notes", notes, TEXT_MAX],
    ["Category", category, CATEGORY_MAX],
  ] as const) {
    if (val && val.length > max) {
      return {
        ok: false,
        error: `${label} is too long (max ${max} characters).`,
      };
    }
  }

  const imageUrl = parseOptionalUrl(raw.imageUrl);
  if (imageUrl === false) {
    return {
      ok: false,
      error: "Image URL must be a valid http(s) link (max 1000 characters).",
    };
  }

  const instructions = nullableText(raw.instructions);
  const guidelines = nullableText(raw.guidelines);
  const tips = nullableText(raw.tips);
  for (const [label, val] of [
    ["Instructions", instructions],
    ["Guidelines", guidelines],
    ["Tips", tips],
  ] as const) {
    if (val && val.length > CONTENT_MAX) {
      return {
        ok: false,
        error: `${label} is too long (max ${CONTENT_MAX} characters).`,
      };
    }
  }

  return {
    ok: true,
    value: {
      name,
      sets,
      reps,
      rest,
      notes,
      category,
      imageUrl,
      instructions,
      guidelines,
      tips,
    },
  };
}
