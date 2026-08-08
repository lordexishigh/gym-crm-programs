/**
 * Member profile photo: sizing rules, upload validation, content sniffing, and
 * the avatar source resolution shared by every surface that renders a face.
 *
 * PURE by design — no database, no env, no server-only imports. The browser
 * uploader (app/dashboard/members/MemberPhotoPanel.tsx) and the Server Action
 * that persists the bytes therefore enforce exactly ONE set of rules, and every
 * rule below is unit-testable without a database (see test/member-photo.test.ts).
 * This also keeps the module safe to import from a client component, which any
 * lib/ module reachable from the browser bundle must be.
 */

/** Image formats accepted for a profile photo. */
export const ALLOWED_PHOTO_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type PhotoContentType = (typeof ALLOWED_PHOTO_TYPES)[number];

/** `accept` attribute for the file input — same allowlist, one source. */
export const PHOTO_ACCEPT_ATTR = ALLOWED_PHOTO_TYPES.join(",");

/** Hard ceiling on a stored photo, in megabytes (used in user-facing copy). */
export const MAX_PHOTO_MB = 2;

/**
 * Hard server-side ceiling on a stored photo.
 *
 * The client downscales to a ~50 KB avatar before uploading, so this bound is
 * never reached in normal use — it exists because the Server Action is a public
 * endpoint and must not accept an arbitrarily large body just because the
 * browser was asked nicely. It sits well under the configured Server Action body
 * limit (next.config.mjs) so an oversized upload fails with THIS readable
 * message rather than a framework-level 413.
 */
export const MAX_PHOTO_BYTES = MAX_PHOTO_MB * 1024 * 1024;

/**
 * Longest edge, in pixels, the client downscales a chosen image to.
 *
 * An avatar is rendered at 96px at most (the edit panel); 512 leaves headroom
 * for high-DPI screens while turning a 4 MB phone photo into tens of kilobytes.
 */
export const MAX_PHOTO_EDGE_PX = 512;

/** JPEG quality used when the client re-encodes the downscaled image. */
export const PHOTO_JPEG_QUALITY = 0.85;

export type PhotoValidation = { ok: true } | { ok: false; error: string };

/**
 * Validate a chosen file BEFORE reading it: type must be an allowed image and
 * size must be non-empty and within the ceiling.
 *
 * The declared `type` is a hint from the browser and is checked here only so the
 * user gets a fast, specific message. It is NOT what the stored content type is
 * derived from — see `sniffImageType`.
 */
export function validatePhotoUpload(file: {
  type?: string | null;
  size: number;
}): PhotoValidation {
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, error: "That file is empty. Choose an image to upload." };
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return {
      ok: false,
      error: `That image is too large (max ${MAX_PHOTO_MB} MB). Try a smaller photo.`,
    };
  }
  const type = (file.type ?? "").toLowerCase();
  if (!ALLOWED_PHOTO_TYPES.includes(type as PhotoContentType)) {
    return { ok: false, error: "Photos must be a JPEG, PNG or WebP image." };
  }
  return { ok: true };
}

/**
 * Derive the content type from the file's MAGIC NUMBER rather than its declared
 * MIME type.
 *
 * This matters because the stored content type is echoed back verbatim by the
 * photo route. Trusting `File.type` would let a caller upload arbitrary bytes
 * labelled `image/png` and have the application serve them back under that
 * content type. Reading the signature means the response can only ever describe
 * what the bytes actually are, and anything unrecognised is refused outright.
 *
 * Returns null when the bytes are not one of the three allowed formats.
 */
export function sniffImageType(bytes: Uint8Array): PhotoContentType | null {
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= PNG.length && PNG.every((b, i) => bytes[i] === b)) {
    return "image/png";
  }
  // WebP: "RIFF" ....(4-byte size).... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `value` is a UUID.
 *
 * Used to reject a malformed member id before it reaches Postgres: an
 * unparseable uuid is a `22P02` error mid-transaction, which surfaces as "could
 * not save" (or a 500 on the photo route) when the honest answer is "no such
 * member". Cheap guard, much better failure mode.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** The authenticated URL an uploaded member photo is served from. */
export function memberPhotoHref(
  memberId: string,
  updatedAt: string | Date,
): string {
  const version =
    updatedAt instanceof Date ? updatedAt.toISOString() : String(updatedAt);
  // The version turns an updated photo into a NEW url, which is what lets the
  // route mark the response immutable and still show a fresh upload instantly.
  return `/api/members/${memberId}/photo?v=${encodeURIComponent(version)}`;
}

/**
 * Resolve which image (if any) to render for a member.
 *
 * An uploaded photo wins; otherwise the externally-hosted `photo_url` from 0013
 * is used, so records imported from a CSV or another system keep their picture.
 * Null means "no photo" — render initials.
 */
export function memberAvatarSrc(member: {
  id: string;
  photo_updated_at?: string | Date | null;
  photo_url?: string | null;
}): string | null {
  if (member.photo_updated_at) {
    return memberPhotoHref(member.id, member.photo_updated_at);
  }
  const url = member.photo_url?.trim();
  return url ? url : null;
}

/**
 * Initials for the no-photo fallback: first letter of the first and last name
 * parts (just the first letter for a single-word name). Returns "?" when the
 * name has no letters at all, so the avatar is never an empty circle.
 */
export function initialsOf(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((p) => /\p{L}|\p{N}/u.test(p));
  if (parts.length === 0) return "?";
  const first = [...parts[0]][0] ?? "";
  const last = parts.length > 1 ? ([...parts[parts.length - 1]][0] ?? "") : "";
  return (first + last).toUpperCase();
}
