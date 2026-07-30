import { initialsOf } from "@/lib/member-photo";

/**
 * Member avatar — the single component every surface uses to put a face to a
 * record (roster, member detail, the photo editor's preview).
 *
 * Deliberately a PLAIN presentational component with no "use client" and no
 * data access, so it renders in Server Components (the roster and detail pages)
 * and inside the client-side upload panel alike. Falls back to initials rather
 * than a broken-image icon when there is no photo, and keeps the ring/shape
 * identical across sizes so a roster of mixed photo/no-photo rows still lines up.
 *
 * `<img>` is used rather than `next/image` on purpose: the source is either an
 * authenticated same-origin route or an arbitrary externally-hosted URL from an
 * imported record, neither of which the image optimiser can be configured for
 * ahead of time (a non-allowlisted remote host is a hard 400 from the optimiser,
 * i.e. a broken avatar). These are 96px-max thumbnails already downscaled at
 * upload, so there is nothing to optimise.
 */

const SIZES = {
  /** Roster rows. */
  sm: { box: "h-9 w-9", text: "text-sm" },
  /** Page headers. */
  md: { box: "h-14 w-14", text: "text-lg" },
  /** The photo editor preview. */
  lg: { box: "h-24 w-24", text: "text-2xl" },
} as const;

export type AvatarSize = keyof typeof SIZES;

export function Avatar({
  name,
  src = null,
  size = "sm",
  className = "",
}: {
  /** Full name — used for the alt text and the initials fallback. */
  name: string;
  /** Resolved image URL, or null for the initials fallback. */
  src?: string | null;
  size?: AvatarSize;
  className?: string;
}) {
  const { box, text } = SIZES[size];
  const shell = `${box} shrink-0 rounded-full bg-slate-100 ring-1 ring-slate-200 ${className}`;

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={`${name} profile photo`}
        className={`${shell} object-cover`}
      />
    );
  }

  return (
    <span
      // Decorative: the member's name is always rendered next to this, so the
      // initials would only repeat it to a screen reader.
      aria-hidden
      className={`${shell} flex items-center justify-center ${text} font-semibold text-slate-500`}
    >
      {initialsOf(name)}
    </span>
  );
}
