import type { LibraryExerciseDetail } from "@/lib/exercise-library";

/**
 * Presentational exercise-library grid (alpha-exercise-library-003).
 *
 * Pure rendering — given the rows and a delete Server Action, it draws a
 * responsive grid of rich cards (image, sets/reps/rest, notes, and an
 * expandable "How to perform" block with instructions, guidelines, and tips).
 * Built-in (seeded) exercises are badged so trainers can tell the starter
 * catalog from their own additions. Kept free of data access and `requireStaff`
 * so it renders in a view test without a session or database
 * (see test/exercise-library-view.test.ts).
 */
export function ExerciseLibraryGrid({
  exercises,
  deleteAction,
}: {
  exercises: LibraryExerciseDetail[];
  deleteAction: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {exercises.map((e) => (
        <ExerciseCard key={e.id} exercise={e} deleteAction={deleteAction} />
      ))}
    </ul>
  );
}

/** A single library exercise rendered as a rich, mobile-first card. */
function ExerciseCard({
  exercise: e,
  deleteAction,
}: {
  exercise: LibraryExerciseDetail;
  deleteAction: (formData: FormData) => void | Promise<void>;
}) {
  const stats = [
    e.sets !== null ? `${e.sets} sets` : null,
    e.reps ? `${e.reps} reps` : null,
    e.rest ? `${e.rest} rest` : null,
  ].filter(Boolean);

  const hasContent = Boolean(e.instructions || e.guidelines || e.tips);

  return (
    <li className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      <ExerciseThumb imageUrl={e.imageUrl} name={e.name} category={e.category} />

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="truncate font-semibold text-slate-900">
              {e.name}
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {e.category ? (
                <span className="inline-flex items-center rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">
                  {e.category}
                </span>
              ) : null}
              {e.isSeeded ? (
                <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                  Built-in
                </span>
              ) : null}
            </div>
          </div>
          <form action={deleteAction} className="shrink-0">
            <input type="hidden" name="id" value={e.id} />
            <button
              type="submit"
              aria-label={`Remove ${e.name} from the library`}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50"
            >
              Remove
            </button>
          </form>
        </div>

        <p className="text-sm text-slate-500">
          {stats.length > 0 ? stats.join(" · ") : "No default sets/reps"}
        </p>
        {e.notes ? <p className="text-sm text-slate-600">{e.notes}</p> : null}

        {hasContent ? (
          <details className="mt-auto rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
            <summary className="cursor-pointer select-none text-sm font-medium text-brand">
              How to perform
            </summary>
            <div className="mt-3 flex flex-col gap-3 text-sm text-slate-700">
              <ContentSection label="Instructions" body={e.instructions} />
              <ContentSection label="Guidelines" body={e.guidelines} />
              <ContentSection label="Tips" body={e.tips} />
            </div>
          </details>
        ) : null}
      </div>
    </li>
  );
}

function ContentSection({
  label,
  body,
}: {
  label: string;
  body: string | null;
}) {
  if (!body) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </span>
      <p className="whitespace-pre-line leading-relaxed">{body}</p>
    </div>
  );
}

/**
 * Exercise image, or a tasteful brand-tinted placeholder when none is set
 * (built-in catalog entries ship with a demonstration image; a gym can paste an
 * Image URL to replace it, or leave a custom exercise imageless). Uses a plain
 * <img> intentionally — image URLs are arbitrary, so next/image's remote
 * allow-list does not apply.
 */
function ExerciseThumb({
  imageUrl,
  name,
  category,
}: {
  imageUrl: string | null;
  name: string;
  category: string | null;
}) {
  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt={`${name} demonstration`}
        loading="lazy"
        referrerPolicy="no-referrer"
        className="h-36 w-full object-cover"
      />
    );
  }
  return (
    <div className="flex h-36 w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-brand/10 to-slate-100">
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-9 w-9 text-brand"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6.5 6.5l11 11M5 8l-1.5-1.5M19 16l1.5 1.5" />
        <rect x="3.5" y="3.5" width="4" height="4" rx="1" transform="rotate(45 5.5 5.5)" />
        <rect x="16.5" y="16.5" width="4" height="4" rx="1" transform="rotate(45 18.5 18.5)" />
      </svg>
      <span className="text-xs font-medium text-slate-500">
        {category ?? "Exercise"}
      </span>
    </div>
  );
}
