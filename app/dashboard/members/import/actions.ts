"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import { parseMemberCsv, type ImportRow } from "@/lib/member-import";
import { assignPinCodes } from "@/lib/checkin";
import { reportHandledError } from "@/lib/observability/monitoring";

/**
 * Bulk member import (market gap: adoption).
 *
 * The browser previews the file client-side, but this action re-parses the raw
 * CSV text with the SAME pure module before writing — the preview is a courtesy,
 * never the authority. A crafted POST therefore gets identical validation, and
 * `requireStaff` + `withTenantContext` mean the rows land in the caller's own
 * gym under RLS; there is no public bulk-insert endpoint.
 *
 * The whole import is one transaction: either every accepted row (with its
 * status history and check-in PIN) is created, or none is. A half-finished
 * import is far worse than a failed one — staff would have to work out which of
 * their 600 members already exist before retrying.
 */

export type ImportSummary = {
  /** Rows actually inserted. */
  imported: number;
  /** Rows skipped because a member with that email already exists. */
  skippedExisting: number;
  /** Rows the file-level validation rejected (bad email, missing name, dupes). */
  skippedInvalid: number;
  /** Data rows seen in the file. */
  total: number;
};

export type ImportActionState = { error?: string; summary?: ImportSummary };

export async function importMembersAction(
  _prev: ImportActionState,
  formData: FormData,
): Promise<ImportActionState> {
  const session = await requireStaff();

  const csv = formData.get("csv");
  if (typeof csv !== "string" || csv.trim() === "") {
    return { error: "No file contents were submitted. Choose a CSV file and try again." };
  }

  const preview = parseMemberCsv(csv);
  if (!preview.ok) return { error: preview.error };

  const total = preview.rows.length + preview.issues.length;
  if (preview.rows.length === 0) {
    return {
      error: "None of the rows in that file could be imported. Fix the problems listed and re-upload.",
    };
  }

  let inserted: number;
  let skippedExisting: number;
  try {
    ({ inserted, skippedExisting } = await withTenantContext(
      session.identity,
      async (c) => {
        // Skip anyone already on the roster (matched on email, case-insensitively
        // — validateMemberInput has already lowercased ours). Re-importing an
        // export must not silently duplicate the whole gym. RLS scopes the
        // lookup to this tenant, so another gym's member never blocks a row.
        const emails = preview.rows
          .map((r) => r.input.email)
          .filter((e): e is string => e !== null);

        const existing = new Set<string>(
          emails.length === 0
            ? []
            : (
                await c.query<{ email: string }>(
                  "select lower(email) as email from member where lower(email) = any($1::text[])",
                  [emails],
                )
              ).rows.map((r) => r.email),
        );

        const toInsert = preview.rows.filter(
          (r) => r.input.email === null || !existing.has(r.input.email),
        );
        if (toInsert.length === 0) {
          return { inserted: 0, skippedExisting: preview.rows.length };
        }

        const col = <T>(pick: (r: ImportRow) => T): T[] => toInsert.map(pick);

        // One statement for all rows. `returning id, status` pairs each new id
        // with its own status, so the status-history insert below never depends
        // on the (unspecified) ordering of RETURNING.
        const { rows: created } = await c.query<{ id: string; status: string }>(
          `insert into member
             (tenant_id, full_name, email, phone, status, notes, photo_url,
              emergency_contact_name, emergency_contact_phone, membership_status)
           select $1::uuid, f.full_name, f.email, f.phone, f.status, f.notes, f.photo_url,
                  f.ec_name, f.ec_phone, f.membership_status
             from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                         $7::text[], $8::text[], $9::text[], $10::text[])
               as f(full_name, email, phone, status, notes, photo_url,
                    ec_name, ec_phone, membership_status)
           returning id, status`,
          [
            session.identity.tenantId,
            col((r) => r.input.fullName),
            col((r) => r.input.email),
            col((r) => r.input.phone),
            col((r) => r.input.status),
            col((r) => r.input.notes),
            col((r) => r.input.photoUrl),
            col((r) => r.input.emergencyContactName),
            col((r) => r.input.emergencyContactPhone),
            col((r) => r.input.membershipStatus),
          ],
        );

        // Seed each member's status history exactly as createMemberAction does
        // (old_status null = "created with this status"). changed_by targets
        // users(id) while the JWT carries the Supabase auth id; null when
        // unmatched — the column is nullable and this is informational.
        const changedBy = session.identity.userId
          ? ((
              await c.query<{ id: string }>(
                "select id from users where auth_user_id = $1",
                [session.identity.userId],
              )
            ).rows[0]?.id ?? null)
          : null;

        await c.query(
          `insert into member_status_event
             (tenant_id, member_id, old_status, new_status, changed_by)
           select $1, f.member_id::uuid, null, f.status, $4
             from unnest($2::text[], $3::text[]) as f(member_id, status)`,
          [
            session.identity.tenantId,
            created.map((r) => r.id),
            created.map((r) => r.status),
            changedBy,
          ],
        );

        // Every member gets a check-in PIN from day one, same as the single-add
        // path — an imported member must work at the front desk immediately.
        await assignPinCodes(
          c,
          session.identity.tenantId,
          created.map((r) => r.id),
        );

        return {
          inserted: created.length,
          skippedExisting: preview.rows.length - toInsert.length,
        };
      },
    ));
  } catch (err) {
    await reportHandledError(err, "import-members-csv", {
      tenantId: session.identity.tenantId,
    });
    return {
      error: "Could not import the members — nothing was saved. Please try again.",
    };
  }

  revalidatePath("/dashboard/members");

  return {
    summary: {
      imported: inserted,
      skippedExisting,
      skippedInvalid: preview.issues.length,
      total,
    },
  };
}
