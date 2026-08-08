import { getSession } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import { reportHandledError } from "@/lib/observability/monitoring";
import {
  ALLOWED_PHOTO_TYPES,
  isUuid,
  type PhotoContentType,
} from "@/lib/member-photo";

/**
 * Serve a member's uploaded profile photo (market gap: member profile photo).
 *
 * ACCESS CONTROL IS RLS, NOT THIS HANDLER. The only check made here is "is there
 * a valid session at all"; the read then runs through `withTenantContext` as the
 * unprivileged `app_user`, so `member_photo_staff_all` scopes a staff caller to
 * their own gym and `member_photo_self_select` scopes a member caller to their
 * own single row. A photo belonging to another tenant — or to another member of
 * the same gym, requested by a member — simply resolves to no row and 404s. The
 * handler cannot leak a photo by forgetting a predicate, because it has none.
 */

export const dynamic = "force-dynamic";

type PhotoRow = {
  content_type: string;
  bytes: Buffer;
  updated_at: Date | string;
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const session = await getSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }
  // A malformed id would be a 22P02 mid-transaction; "no such photo" is the
  // honest answer and keeps a probe from distinguishing bad-id from no-photo.
  if (!isUuid(id)) {
    return new Response("Not found", { status: 404 });
  }

  let row: PhotoRow | null;
  try {
    row = await withTenantContext(session.identity, async (c) => {
      const { rows } = await c.query<PhotoRow>(
        "select content_type, bytes, updated_at from member_photo where member_id = $1",
        [id],
      );
      return rows[0] ?? null;
    });
  } catch (err) {
    await reportHandledError(err, "member-photo-read", {
      tenantId: session.identity.tenantId,
      memberId: id,
    });
    return new Response("Photo unavailable", { status: 503 });
  }

  if (!row) {
    return new Response("Not found", { status: 404 });
  }

  // The stored type is already constrained by a CHECK constraint and derived
  // from the bytes at upload; re-checking here means a hand-edited row still
  // cannot make this route emit an arbitrary content type.
  const contentType = ALLOWED_PHOTO_TYPES.includes(
    row.content_type as PhotoContentType,
  )
    ? row.content_type
    : "application/octet-stream";

  const body = new Uint8Array(row.bytes);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(body.byteLength),
      // Never render as anything but the declared image type.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      // Safe to cache aggressively *and privately*: the URL carries the photo's
      // updated_at (see `memberPhotoHref`), so replacing a photo produces a new
      // URL rather than a stale hit, and `private` keeps a shared proxy from
      // holding one member's face for another viewer.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
