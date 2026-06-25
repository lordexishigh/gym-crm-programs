import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExerciseLibraryGrid } from "../app/dashboard/exercises/ExerciseLibraryGrid";
import type { LibraryExerciseDetail } from "../lib/exercise-library";
import { EXERCISE_CATALOG } from "../scripts/seed.mjs";

/**
 * Exercise library VIEW + catalog-data tests (alpha-exercise-library-003).
 *
 * Complements the RLS read-path coverage by proving, without a session or
 * database, that:
 *   - the rich card surfaces every reference field (image, instructions,
 *     guidelines, tips) and badges built-in (seeded) rows as "Built-in";
 *   - user-created (non-seeded) rows are NOT badged;
 *   - the built-in catalog that gets seeded into every gym is well-formed —
 *     real https demonstration images and full teaching content — so the
 *     "already inside the CRM" promise holds the moment a gym is seeded.
 */

const noopDelete = async () => {};

const seeded: LibraryExerciseDetail = {
  id: "ex-seeded",
  name: "Back Squat",
  sets: 5,
  reps: "5",
  rest: "120s",
  notes: null,
  category: "Legs",
  imageUrl: "https://cdn.example.com/back-squat.jpg",
  instructions: "Set the bar across your upper back and unrack.",
  guidelines: "Keep the knees tracking over the toes.",
  tips: "Spread the floor with your feet.",
  isSeeded: true,
};

const custom: LibraryExerciseDetail = {
  id: "ex-custom",
  name: "Cable Fly",
  sets: 3,
  reps: "12",
  rest: "60s",
  notes: "Members' own addition.",
  category: "Push",
  imageUrl: null,
  instructions: null,
  guidelines: null,
  tips: null,
  isSeeded: false,
};

const render = (exercises: LibraryExerciseDetail[]) =>
  renderToStaticMarkup(
    createElement(ExerciseLibraryGrid, { exercises, deleteAction: noopDelete }),
  );

describe("ExerciseLibraryGrid", () => {
  it("renders the image, instructions, guidelines, and tips of a seeded exercise", () => {
    const html = render([seeded]);

    expect(html).toContain("Back Squat");
    expect(html).toContain("https://cdn.example.com/back-squat.jpg");
    expect(html).toContain("Instructions");
    expect(html).toContain("Set the bar across your upper back and unrack.");
    expect(html).toContain("Guidelines");
    expect(html).toContain("Keep the knees tracking over the toes.");
    expect(html).toContain("Tips");
    expect(html).toContain("Spread the floor with your feet.");
  });

  it("badges a seeded row as Built-in", () => {
    expect(render([seeded])).toContain("Built-in");
  });

  it("does NOT badge a user-created (non-seeded) row, and shows a placeholder when imageless", () => {
    const html = render([custom]);
    expect(html).toContain("Cable Fly");
    expect(html).not.toContain("Built-in");
    // No <img> for a row without an image URL — the branded placeholder shows.
    expect(html).not.toContain("<img");
  });

  it("offers a remove control per exercise", () => {
    const html = render([seeded, custom]);
    expect(html).toContain("Remove Back Squat from the library");
    expect(html).toContain("Remove Cable Fly from the library");
  });
});

describe("EXERCISE_CATALOG (built-in, seeded into every gym)", () => {
  it("ships a non-trivial catalog", () => {
    expect(EXERCISE_CATALOG.length).toBeGreaterThanOrEqual(10);
  });

  it("every entry has a name, a real https image, and full teaching content", () => {
    for (const ex of EXERCISE_CATALOG) {
      expect(ex.name, "name").toBeTruthy();
      expect(ex.image_url, `${ex.name} image_url`).toMatch(/^https:\/\//);
      // No placeholder/example hosts — these must be reachable demonstration images.
      expect(ex.image_url).not.toMatch(/example\.com|placeholder/i);
      expect(ex.instructions, `${ex.name} instructions`).toBeTruthy();
      expect(ex.guidelines, `${ex.name} guidelines`).toBeTruthy();
      expect(ex.tips, `${ex.name} tips`).toBeTruthy();
    }
  });

  it("has case-insensitively unique names (the seed upsert conflict key)", () => {
    const keys = EXERCISE_CATALOG.map((e) => e.name.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });
});
