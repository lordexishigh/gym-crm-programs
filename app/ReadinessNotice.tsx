"use client";

import { useEffect, useState } from "react";

/**
 * "Nobody can sign in on this deployment" — said BEFORE the visitor tries.
 *
 * WHY THIS EXISTS
 *
 * The app already knows when it cannot authenticate anyone: `lib/capabilities.ts`
 * marks `auth` and `database` as "required" capabilities and states the
 * consequence in as many words — "The login pages render but nobody — staff or
 * member — can get past them." That knowledge was reported in exactly two places,
 * `/api/health` and `app/components/CapabilityNotice.tsx`, and the second one
 * lives on the DASHBOARD. So the only person who could read it was someone who
 * had already signed in — which is precisely the thing that is impossible in the
 * state being reported.
 *
 * What a visitor got instead was a confident landing page headed "Sign in with a
 * demo account — no setup required", three sign-in buttons, and a caveat about
 * seed data. Clicking one waits out an auth round-trip and returns
 * "Sign-in is temporarily unavailable. Please try again in a moment" — which
 * describes a transient blip, not an unconfigured deployment that will never work
 * however long you wait. A review walking the app landed exactly there and
 * reported the product as inaccessible with both entry links dead-ending, with no
 * way to tell a missing environment variable from a broken login.
 *
 * So the deployment's readiness is stated on the way IN, on every unauthenticated
 * surface, with the missing variables and their consequence attached.
 *
 * WHAT THIS DOES NOT DO. It does not make the dashboard or portal reachable —
 * nothing in this repository can, because the gap is an absent auth service and
 * an absent database, not code. It makes the app say so, which is the difference
 * between "not ready yet, here is what is missing" and "apparently broken".
 *
 * WHY IT READS /api/health RATHER THAN CALLING `capabilityGaps()` DIRECTLY
 *
 * `/`, `/login` and `/portal/login` are statically prerendered, and that is
 * load-bearing rather than incidental: with no database and no auth service on
 * the request path there is nothing for them to time out on, which is what keeps
 * them serving when everything behind them is down (see app/SessionNotice.tsx for
 * the same constraint). Calling `capabilityGaps()` from those pages would read
 * `process.env` during the BUILD and bake the answer into the prerendered HTML —
 * so a deployment that had its variables added afterwards would keep showing a
 * stale "not ready" notice until someone rebuilt it, and this project's own
 * history says that is a real sequence (`vercel env add` changes nothing live).
 *
 * `/api/health` is already `force-dynamic` and already publishes
 * `capability_gaps`, so reading it from the client keeps the pages static AND the
 * answer live, with one source of truth for what counts as a gap.
 */

/** One "the app cannot function without this" gap, as this component needs it. */
export type RequiredGap = {
  id: string;
  label: string;
  /** Env vars that are unset. May be empty. */
  missing: string[];
  consequence: string;
};

/** How long to wait for the probe before giving up on it. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Pull the "required" gaps out of a `/api/health` body.
 *
 * Only `severity: "required"` is surfaced here, which is the whole editorial
 * decision in this file. `lib/capabilities.ts` also reports "degraded" gaps —
 * email is unconfigured in production today — but an anonymous visitor standing
 * on a login form can do nothing with "invite emails will not be delivered", and
 * a banner that lists things which do not block them is a banner they learn to
 * skip past. The dashboard notice already shows the full set to the operator, who
 * can act on it.
 *
 * Parsed defensively rather than cast: this is a network response, so a truncated
 * body, an HTML error page from a proxy, or a future change to the payload must
 * degrade to "say nothing" instead of throwing inside a render.
 */
export function requiredGapsFrom(payload: unknown): RequiredGap[] {
  if (typeof payload !== "object" || payload === null) return [];
  const raw = (payload as { capability_gaps?: unknown }).capability_gaps;
  if (!Array.isArray(raw)) return [];

  const gaps: RequiredGap[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const gap = entry as Record<string, unknown>;
    if (gap.severity !== "required") continue;

    const id = typeof gap.id === "string" ? gap.id : "";
    const consequence =
      typeof gap.consequence === "string" ? gap.consequence : "";
    // Without an id and a consequence there is nothing worth putting on screen.
    if (!id || !consequence) continue;

    gaps.push({
      id,
      // Fall back to the id so an older deployment answering without `label`
      // still renders something meaningful rather than an empty heading.
      label: typeof gap.label === "string" && gap.label ? gap.label : id,
      missing: Array.isArray(gap.missing)
        ? gap.missing.filter((name): name is string => typeof name === "string")
        : [],
      consequence,
    });
  }
  return gaps;
}

/**
 * The headline, chosen by WHICH capability is missing.
 *
 * A missing auth service and a missing database both stop a visitor getting in,
 * but only the first is honestly described as "cannot sign anyone in" — so the
 * more specific sentence is used whenever it applies.
 */
export function readinessHeadline(gaps: RequiredGap[]): string {
  return gaps.some((gap) => gap.id === "auth")
    ? "This deployment cannot sign anyone in yet"
    : "This deployment is not ready yet";
}

/**
 * The banner itself — pure, hook-free, and exported separately so its markup can
 * be asserted from a plain server render in test/readiness-notice.test.ts.
 *
 * Amber and shaped like `app/components/CapabilityNotice.tsx` on purpose: this is
 * the unauthenticated half of the same message, and the two reading as one thing
 * is the point.
 */
export function ReadinessNoticeBanner({ gaps }: { gaps: RequiredGap[] }) {
  if (gaps.length === 0) return null;

  return (
    <section
      // `role="status"`, matching CapabilityNotice: a standing condition of the
      // deployment announced politely, not an event interrupting the reader.
      role="status"
      aria-label="Deployment readiness"
      className="flex w-full flex-col gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-5 text-left"
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
            {readinessHeadline(gaps)}
          </h2>
          <p className="text-sm text-amber-800">
            The pages below load, but the demo accounts will not let you in until
            an operator configures the services listed here. Waiting or retrying
            will not change that.
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

/**
 * Probe readiness once on mount and render the banner if the deployment cannot
 * be signed into.
 *
 * Renders NOTHING in three cases — while the probe is in flight, when the
 * deployment is ready, and when the probe itself could not be completed. The
 * last one is deliberate: an aborted or unparseable probe is not evidence that
 * anything is wrong, and warning a visitor away from a working login because one
 * request failed would be worse than staying quiet. The bounded wait matters for
 * the same reason the auth and JWKS calls are bounded (lib/auth/supabase.ts) —
 * this runs on the pages that must stay responsive when the services behind them
 * are not.
 */
export function ReadinessNotice() {
  const [gaps, setGaps] = useState<RequiredGap[]>([]);

  useEffect(() => {
    // Guards against setting state after the visitor has navigated away.
    let live = true;

    (async () => {
      try {
        const res = await fetch("/api/health", {
          // Readiness must never be answered from a cache — a stale "ready" is
          // exactly the wrong answer here.
          cache: "no-store",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        // A degraded deployment answers 503 WITH the body we want, so the status
        // is deliberately not checked — only whether the body parses.
        const body: unknown = await res.json();
        if (live) setGaps(requiredGapsFrom(body));
      } catch {
        // Timed out, offline, or not JSON. Say nothing (see the note above).
      }
    })();

    return () => {
      live = false;
    };
  }, []);

  return <ReadinessNoticeBanner gaps={gaps} />;
}
