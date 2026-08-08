import { describe, expect, it } from "vitest";
import {
  ALLOWED_PHOTO_TYPES,
  MAX_PHOTO_BYTES,
  MAX_PHOTO_MB,
  PHOTO_ACCEPT_ATTR,
  initialsOf,
  isUuid,
  memberAvatarSrc,
  memberPhotoHref,
  sniffImageType,
  validatePhotoUpload,
} from "../lib/member-photo";

/**
 * Member profile photo — the rules the browser uploader and the Server Action
 * SHARE (market gap: staff could record every field but not attach a face).
 *
 * All PURE, no database: these pin the limits, the magic-number sniffing that
 * decides what content type the photo route is allowed to serve, and the avatar
 * source precedence. The storage itself (RLS scoping of `member_photo`) is
 * covered by the DB isolation suites, which discover the new table from the
 * catalog and require it to be RLS-enabled, forced, and policied.
 */

const MEMBER_ID = "11111111-2222-3333-4444-555555555555";

/** A minimal file header for each accepted format. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, // "RIFF"
  0x24, 0x00, 0x00, 0x00, // chunk size
  0x57, 0x45, 0x42, 0x50, // "WEBP"
]);

describe("validatePhotoUpload", () => {
  it("accepts each allowed image type within the size ceiling", () => {
    for (const type of ALLOWED_PHOTO_TYPES) {
      expect(validatePhotoUpload({ type, size: 50_000 })).toEqual({ ok: true });
    }
  });

  it("rejects a file that is not an accepted image type", () => {
    const result = validatePhotoUpload({ type: "application/pdf", size: 1000 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/JPEG, PNG or WebP/);
  });

  it("rejects a missing content type rather than assuming one", () => {
    expect(validatePhotoUpload({ type: undefined, size: 1000 }).ok).toBe(false);
    expect(validatePhotoUpload({ type: null, size: 1000 }).ok).toBe(false);
  });

  it("rejects an empty file", () => {
    const result = validatePhotoUpload({ type: "image/png", size: 0 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/empty/i);
  });

  it("allows exactly the ceiling and rejects one byte over", () => {
    expect(
      validatePhotoUpload({ type: "image/jpeg", size: MAX_PHOTO_BYTES }),
    ).toEqual({ ok: true });

    const over = validatePhotoUpload({
      type: "image/jpeg",
      size: MAX_PHOTO_BYTES + 1,
    });
    expect(over.ok).toBe(false);
    // The message must name the limit — "too large" alone tells staff nothing.
    expect(over.ok === false && over.error).toContain(`${MAX_PHOTO_MB} MB`);
  });

  it("is case-insensitive about the declared type", () => {
    expect(validatePhotoUpload({ type: "IMAGE/JPEG", size: 100 })).toEqual({
      ok: true,
    });
  });

  it("offers the same allowlist to the file picker", () => {
    for (const type of ALLOWED_PHOTO_TYPES) {
      expect(PHOTO_ACCEPT_ATTR).toContain(type);
    }
  });
});

describe("sniffImageType", () => {
  it("identifies each accepted format from its magic number", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(WEBP)).toBe("image/webp");
  });

  it("refuses bytes that are not one of the three formats", () => {
    // A PDF mislabelled by the browser as an image is the case that matters:
    // the stored type is echoed on the response, so believing the label would
    // let this application serve arbitrary content as an image.
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
    expect(sniffImageType(pdf)).toBeNull();
    expect(sniffImageType(new Uint8Array([]))).toBeNull();
    expect(sniffImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it("does not mistake a RIFF container that is not WebP", () => {
    // "RIFF....AVI " — right container, wrong payload.
    const avi = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20,
    ]);
    expect(sniffImageType(avi)).toBeNull();
  });
});

describe("isUuid", () => {
  it("accepts a well-formed uuid in either case", () => {
    expect(isUuid(MEMBER_ID)).toBe(true);
    expect(isUuid(MEMBER_ID.toUpperCase())).toBe(true);
  });

  it("rejects anything Postgres would reject with a 22P02", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(`${MEMBER_ID} or 1=1`)).toBe(false);
    expect(isUuid(`${MEMBER_ID}0`)).toBe(false);
  });
});

describe("memberAvatarSrc", () => {
  it("prefers the uploaded photo over an external URL", () => {
    const src = memberAvatarSrc({
      id: MEMBER_ID,
      photo_updated_at: "2026-07-30T10:00:00.000Z",
      photo_url: "https://cdn.example.com/old.jpg",
    });
    expect(src).toContain(`/api/members/${MEMBER_ID}/photo`);
  });

  it("falls back to an externally hosted URL (e.g. an imported record)", () => {
    expect(
      memberAvatarSrc({
        id: MEMBER_ID,
        photo_updated_at: null,
        photo_url: "https://cdn.example.com/jane.jpg",
      }),
    ).toBe("https://cdn.example.com/jane.jpg");
  });

  it("is null when there is no photo at all (render initials)", () => {
    expect(
      memberAvatarSrc({ id: MEMBER_ID, photo_updated_at: null, photo_url: null }),
    ).toBeNull();
    // A blank/whitespace URL is "no photo", not a broken <img>.
    expect(
      memberAvatarSrc({ id: MEMBER_ID, photo_updated_at: null, photo_url: "  " }),
    ).toBeNull();
    expect(memberAvatarSrc({ id: MEMBER_ID })).toBeNull();
  });

  it("versions the url so a replaced photo is never served from cache", () => {
    // The route marks the response immutable, which is only safe because the
    // url changes whenever the photo does.
    const first = memberPhotoHref(MEMBER_ID, "2026-07-30T10:00:00.000Z");
    const second = memberPhotoHref(MEMBER_ID, "2026-07-30T11:00:00.000Z");
    expect(first).not.toBe(second);
    // `pg` hands back a Date for timestamptz; both shapes must resolve alike.
    expect(memberPhotoHref(MEMBER_ID, new Date("2026-07-30T10:00:00.000Z"))).toBe(
      first,
    );
    // The version is query-escaped, so the ':' in an ISO timestamp is encoded.
    expect(first).not.toContain("10:00:00");
  });
});

describe("initialsOf", () => {
  it("uses the first and last name parts", () => {
    expect(initialsOf("Jane Athlete")).toBe("JA");
    expect(initialsOf("Maria Elena Constantinou")).toBe("MC");
  });

  it("uses a single letter for a one-word name", () => {
    expect(initialsOf("Cher")).toBe("C");
  });

  it("handles extra whitespace and lowercase input", () => {
    expect(initialsOf("  nikos   papadopoulos  ")).toBe("NP");
  });

  it("handles non-Latin names", () => {
    expect(initialsOf("Ανδρέας Γεωργίου")).toBe("ΑΓ");
  });

  it("never renders an empty avatar", () => {
    expect(initialsOf("")).toBe("?");
    expect(initialsOf("   ")).toBe("?");
    expect(initialsOf("— -")).toBe("?");
  });
});
