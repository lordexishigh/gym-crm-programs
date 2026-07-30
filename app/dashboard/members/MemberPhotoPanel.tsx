"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/app/components/Avatar";
import {
  MAX_PHOTO_EDGE_PX,
  MAX_PHOTO_MB,
  PHOTO_ACCEPT_ATTR,
  PHOTO_JPEG_QUALITY,
  validatePhotoUpload,
} from "@/lib/member-photo";
import {
  removeMemberPhotoAction,
  uploadMemberPhotoAction,
} from "./actions";

/**
 * Profile-photo editor on the member detail page (market gap: staff could
 * record every contact and safety field but could not attach a face).
 *
 * The chosen image is DOWNSCALED IN THE BROWSER before it is uploaded: a modern
 * phone photo is 3-6 MB and 4000px wide, which is a slow upload on gym wifi and
 * pointless storage for something rendered at 96px. Re-encoding to a
 * {MAX_PHOTO_EDGE_PX}px JPEG turns that into tens of kilobytes. The resize is
 * best-effort — if the browser cannot decode the file, the original is uploaded
 * and the server's own size/format limits still apply, so the feature degrades
 * rather than breaks.
 *
 * The Server Actions are called directly (not via `<form action>`) because the
 * file being sent is the one this component produced, not the one in the input.
 */
export function MemberPhotoPanel({
  memberId,
  memberName,
  photoSrc,
  hasUpload,
}: {
  memberId: string;
  memberName: string;
  /** Currently displayed avatar URL, or null when the member has no photo. */
  photoSrc: string | null;
  /**
   * Whether `photoSrc` is an UPLOADED photo rather than the externally-hosted
   * `photo_url`. Only an upload is this panel's to delete — offering "Remove"
   * for a linked URL would be a button that appears to do nothing (the field
   * that owns it is in the form below).
   */
  hasUpload: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  // Local object URL for an image uploaded in this session, so the new face
  // appears immediately rather than after the server round-trip settles.
  const [preview, setPreview] = useState<string | null>(null);
  // A removal has to hide the face IMMEDIATELY — `router.refresh()` is a round
  // trip, and a photo still sitting there after "Remove" reads as a failure.
  const [removed, setRemoved] = useState(false);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // An object URL is leaked memory until revoked. Keying the cleanup on the URL
  // itself revokes each one exactly when it stops being displayed — whether it
  // was replaced by a newer upload, cleared by a removal, or the page unmounted.
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  // The refreshed server value supersedes the optimistic hide. That matters for
  // a member who ALSO has an externally-hosted `photo_url`: deleting the upload
  // falls back to that URL rather than to no photo at all.
  useEffect(() => {
    setRemoved(false);
  }, [photoSrc]);

  const shown = preview ?? (removed ? null : photoSrc);
  // `preview` means an upload landed in this session, so it is removable too.
  const canRemove = Boolean(preview) || (hasUpload && !removed);
  const showingLinkedPhoto = Boolean(shown) && !canRemove;

  async function handleFile(file: File) {
    setError(null);
    setStatus(null);

    // Check the ORIGINAL first so an obviously wrong file (a PDF, a 40 MB raw)
    // is rejected instantly, before any decode work.
    const chosen = validatePhotoUpload({ type: file.type, size: file.size });
    if (!chosen.ok) {
      setError(chosen.error);
      return;
    }

    setBusy("upload");
    try {
      const prepared = await downscaleImage(file);
      const check = validatePhotoUpload({
        type: prepared.type,
        size: prepared.size,
      });
      if (!check.ok) {
        setError(check.error);
        return;
      }

      const data = new FormData();
      data.set("memberId", memberId);
      data.set("photo", prepared);

      const result = await uploadMemberPhotoAction(data);
      if (result.error) {
        setError(result.error);
        return;
      }

      setRemoved(false);
      setPreview(URL.createObjectURL(prepared));
      setStatus(result.success ?? "Photo updated.");
      router.refresh();
    } catch {
      setError("Could not upload the photo. Please try again.");
    } finally {
      setBusy(null);
      // Allow re-selecting the same file after a failure.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleRemove() {
    setError(null);
    setStatus(null);
    setBusy("remove");
    try {
      const data = new FormData();
      data.set("memberId", memberId);
      const result = await removeMemberPhotoAction(data);
      if (result.error) {
        setError(result.error);
        return;
      }
      setPreview(null);
      setRemoved(true);
      setStatus(result.success ?? "Photo removed.");
      router.refresh();
    } catch {
      setError("Could not remove the photo. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center">
      <Avatar name={memberName} src={shown} size="lg" />

      <div className="flex min-w-0 flex-col gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">
          Profile photo
        </h2>
        <p className="text-sm text-slate-600">
          {showingLinkedPhoto
            ? "This photo comes from the Photo URL field below. Upload one to store it here instead."
            : shown
              ? "Shown on the roster and at check-in, so staff recognise this member at the front desk."
              : `Add a photo so staff recognise this member at the front desk. JPEG, PNG or WebP, up to ${MAX_PHOTO_MB} MB.`}
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy !== null}
            className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === "upload"
              ? "Uploading…"
              : shown
                ? "Replace photo"
                : "Upload photo"}
          </button>

          {canRemove ? (
            <button
              type="button"
              onClick={handleRemove}
              disabled={busy !== null}
              className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === "remove" ? "Removing…" : "Remove"}
            </button>
          ) : null}
        </div>

        {/* The visible controls above are the buttons; this input is the file
            picker they open. Labelled for assistive tech rather than hidden
            from it, and kept out of the tab order so focus lands on the button
            that actually describes the action. */}
        <input
          ref={inputRef}
          type="file"
          accept={PHOTO_ACCEPT_ATTR}
          aria-label="Choose a profile photo"
          tabIndex={-1}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />

        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
        {status && !error ? (
          <p role="status" className="text-sm text-emerald-600">
            {status}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Shrink an image to a {MAX_PHOTO_EDGE_PX}px-longest-edge JPEG.
 *
 * Returns the ORIGINAL file whenever anything is unavailable or fails (no
 * `createImageBitmap`, an undecodable file, a canvas that refuses to export) —
 * the server re-validates size and format either way, so a failed resize costs
 * bandwidth, never correctness.
 *
 * The canvas is filled white before drawing because a transparent PNG would
 * otherwise flatten to black in a JPEG.
 */
async function downscaleImage(file: File): Promise<File> {
  if (typeof createImageBitmap !== "function") return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }

  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > MAX_PHOTO_EDGE_PX ? MAX_PHOTO_EDGE_PX / longest : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", PHOTO_JPEG_QUALITY);
    });
    if (!blob || blob.size === 0) return file;

    return new File([blob], "member-photo.jpg", { type: "image/jpeg" });
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
}
