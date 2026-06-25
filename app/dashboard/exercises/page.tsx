import { requireStaff } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import type { LibraryExerciseDetail } from "@/lib/exercise-library";
import { ExerciseLibraryForm } from "./ExerciseLibraryForm";
import { ExerciseLibraryGrid } from "./ExerciseLibraryGrid";
import { deleteLibraryExerciseAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Exercise library (alpha-exercise-library-001/003). A reusable, tenant-scoped
 * catalog — RLS (`exercise_library_staff_all`) scopes every row to the staff
 * member's own gym, so the query carries no tenant predicate. Each gym is
 * seeded with a built-in starter catalog (scripts/seed.mjs, run on boot by
 * instrumentation.ts) carrying images, instructions, guidelines, and tips, so
 * trainers have exercises ready to use out of the box. They are searchable and
 * category-filterable here, and selectable in ProgramBuilder.
 */
export default async function ExerciseLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string }>;
}) {
  const session = await requireStaff();
  const sp = await searchParams;
  const q = sp.q?.trim() ?? "";
  const category = sp.category?.trim() ?? "";

  const { exercises, categories } = await withTenantContext(
    session.identity,
    async (c) => {
      const { rows } = await c.query<LibraryExerciseDetail>(
        `select id, name, sets, reps, rest, notes, category,
                image_url   as "imageUrl",
                instructions, guidelines, tips,
                is_seeded   as "isSeeded"
           from exercise_library
          where ($1::text is null
             or name              ilike $1
             or coalesce(category, '')     ilike $1
             or coalesce(notes, '')        ilike $1
             or coalesce(instructions, '') ilike $1
             or coalesce(guidelines, '')   ilike $1
             or coalesce(tips, '')         ilike $1)
            and ($2::text is null or category = $2)
          order by is_seeded desc, lower(name) asc`,
        [q ? `%${q}%` : null, category || null],
      );

      // Distinct categories (across the whole library, not just the filtered
      // result) populate the filter dropdown.
      const { rows: catRows } = await c.query<{ category: string }>(
        `select distinct category from exercise_library
          where category is not null and category <> ''
          order by category asc`,
      );

      return { exercises: rows, categories: catRows.map((r) => r.category) };
    },
  );

  const filtering = q !== "" || category !== "";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Exercise library</h1>
        <p className="text-sm text-slate-600">
          A searchable catalog for your gym — built-in exercises with images,
          instructions, guidelines, and tips, plus any you add. Insert them when
          building a program.
        </p>
      </div>

      <ExerciseLibraryForm />

      {/* Search + category filter (GET form → ?q=…&category=…; server-rendered,
          shareable, back-button friendly, no client JS needed). */}
      <form
        method="get"
        role="search"
        className="flex flex-col gap-2 sm:flex-row sm:items-center"
      >
        <label htmlFor="library-search" className="sr-only">
          Search exercises
        </label>
        <input
          id="library-search"
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by name, category, or content…"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />
        <label htmlFor="library-category" className="sr-only">
          Filter by category
        </label>
        <select
          id="library-category"
          name="category"
          defaultValue={category}
          className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        >
          <option value="">All categories</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="shrink-0 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
        >
          Search
        </button>
      </form>

      <div className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-slate-900">
          {filtering ? "Results" : "Library"} ({exercises.length})
        </h2>

        {exercises.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
            {filtering
              ? "No exercises match your search. Try a different term or category."
              : "No exercises yet. Add your first exercise above to start your gym’s library."}
          </div>
        ) : (
          <ExerciseLibraryGrid
            exercises={exercises}
            deleteAction={deleteLibraryExerciseAction}
          />
        )}
      </div>
    </div>
  );
}
