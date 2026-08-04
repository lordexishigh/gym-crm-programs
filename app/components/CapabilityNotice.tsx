import { capabilityGaps } from "@/lib/capabilities";

/**
 * Tells staff what this deployment silently cannot do.
 *
 * The failure it exists to prevent: production has no `RESEND_API_KEY`, so
 * `sendEmail()` returns `not_configured` and every path that sends mail degrades
 * politely — a trainer invites a member, sees a success message, and waits for
 * an email that was never attempted. The product looked complete from inside the
 * product, which is the only place anyone was looking.
 *
 * So the gap is stated where the work happens, with its consequence and the fix
 * attached. `lib/capabilities.ts` decides what counts as worth reporting:
 * "optional" gaps are excluded on purpose, because a notice that lists
 * switched-off features nobody asked for is a notice people learn to skip.
 *
 * Rendered nowhere unless something is actually wrong — the common case is that
 * this component returns null.
 */
export function CapabilityNotice() {
  const gaps = capabilityGaps();
  if (gaps.length === 0) return null;

  return (
    <section
      // `role="status"` rather than `alert`: this is a standing condition of the
      // deployment, not an event that just happened, so it should be announced
      // politely when the page loads instead of interrupting a screen-reader
      // user mid-sentence.
      role="status"
      aria-label="Deployment configuration warnings"
      className="flex flex-col gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-5"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-200/70 text-amber-900"
        >
          <svg
            width={18}
            height={18}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-amber-900">
            {gaps.length === 1
              ? "One feature is not configured on this deployment"
              : `${gaps.length} features are not configured on this deployment`}
          </h2>
          <p className="text-sm text-amber-800">
            The app is running, but the following will not happen. Nothing in the
            product will report these as failures at the time.
          </p>
        </div>
      </div>

      <ul className="flex flex-col gap-3 pl-11">
        {gaps.map((gap) => (
          <li key={gap.id} className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold text-amber-900">
              {gap.label}
            </span>
            <span className="text-sm text-amber-800">{gap.consequence}</span>
            {gap.missing.length > 0 && (
              <span className="text-xs text-amber-700">
                Set{" "}
                {gap.missing.map((name, i) => (
                  <span key={name}>
                    {i > 0 && ", "}
                    <code className="rounded bg-amber-200/60 px-1 py-0.5 font-mono">
                      {name}
                    </code>
                  </span>
                ))}{" "}
                in the deployment environment (see <code>.env.example</code>).
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
