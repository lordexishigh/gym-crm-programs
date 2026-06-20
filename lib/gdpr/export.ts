import { withTenantContext, type Identity } from "../db";
import type { ExerciseRow } from "../programs";
import {
  MEMBER_STATUS_HISTORY_SQL,
  type MemberStatusEvent,
} from "../member-records";
import { recordGdprEvent, resolveActorUserId } from "./audit";

/**
 * Member data export (beta-gdpr-001).
 *
 * Builds a portable JSON document of a single data subject's (member's) personal
 * data and logs the export to the audit trail — both in ONE tenant-scoped
 * transaction so an export is recorded iff it succeeds. Isolation is enforced by
 * RLS, not by these queries: every read runs as the unprivileged `app_user`, so
 * a staff caller sees only members in their own gym and a member caller sees only
 * their own rows. A crafted/cross-tenant `memberId` therefore resolves to no
 * data — which the `gdpr-export-rls` test asserts directly.
 *
 * Scope by role:
 *   - staff (DSAR fulfilment): the complete record — profile, status history,
 *     invites, and all assigned programs with exercises.
 *   - member (self-service): profile + assigned programs/exercises. The
 *     staff-internal tables (status history, invite tokens) are controller
 *     records the member RLS policies do not expose; they are omitted rather
 *     than relied upon to return empty.
 */

/** A subject's exported member profile (all stored personal fields). */
export type ExportedMember = {
  id: string;
  email: string | null;
  full_name: string;
  phone: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  erased_at: string | null;
};

/** One exported invite (token hashes are never included). */
export type ExportedInvite = {
  id: string;
  email: string;
  status: string;
  expires_at: string | null;
  created_at: string;
  accepted_at: string | null;
};

/** An assigned program with its ordered exercises, as exported. */
export type ExportedProgram = {
  assignment_id: string;
  status: string;
  assigned_at: string;
  program: {
    id: string;
    name: string;
    description: string | null;
  };
  exercises: ExerciseRow[];
};

/** The full export document handed to the data subject. */
export type MemberDataExport = {
  format: "alpha-crm.member-export";
  format_version: 1;
  subject: { type: "member"; id: string };
  member: ExportedMember;
  status_history: MemberStatusEvent[];
  invites: ExportedInvite[];
  programs: ExportedProgram[];
};

/** Result of an export: the document (null if the subject was not found). */
export type ExportResult = { data: MemberDataExport | null };

/**
 * Export `memberId`'s personal data under `identity`, logging the action. Returns
 * `{ data: null }` when the member is not visible to the caller (not found,
 * other member, or cross-tenant) — the route maps that to a 404.
 */
export async function exportMemberData(
  identity: Identity,
  memberId: string,
): Promise<ExportResult> {
  const isStaff = identity.role === "staff";

  return withTenantContext(identity, async (c) => {
    const member = (
      await c.query<ExportedMember>(
        `select id, email, full_name, phone, status, notes,
                created_at, updated_at, erased_at
           from member where id = $1`,
        [memberId],
      )
    ).rows[0];
    // RLS makes an out-of-scope id resolve to no row — nothing to export.
    if (!member) return { data: null };

    // Staff-only controller records (members' RLS policies do not expose these).
    const statusHistory = isStaff
      ? (await c.query<MemberStatusEvent>(MEMBER_STATUS_HISTORY_SQL, [memberId]))
          .rows
      : [];
    const invites = isStaff
      ? (
          await c.query<ExportedInvite>(
            `select id, email, status, expires_at, created_at, accepted_at
               from invite where member_id = $1
              order by created_at desc`,
            [memberId],
          )
        ).rows
      : [];

    // Assignments + program summaries + exercises, both roles' own scope.
    const assignments = (
      await c.query<{
        assignment_id: string;
        status: string;
        assigned_at: string;
        program_id: string;
        name: string;
        description: string | null;
      }>(
        `select pa.id as assignment_id, pa.status, pa.assigned_at,
                p.id as program_id, p.name, p.description
           from program_assignment pa
           join program p on p.id = pa.program_id
          where pa.member_id = $1
          order by pa.assigned_at desc`,
        [memberId],
      )
    ).rows;

    const programIds = assignments.map((a) => a.program_id);
    const exercises =
      programIds.length > 0
        ? (
            await c.query<ExerciseRow>(
              `select id, program_id, position, name, sets, reps, rest, notes
                 from exercise
                where program_id = any($1::uuid[])
                order by program_id, position asc`,
              [programIds],
            )
          ).rows
        : [];

    const byProgram = new Map<string, ExerciseRow[]>();
    for (const ex of exercises) {
      const list = byProgram.get(ex.program_id) ?? [];
      list.push(ex);
      byProgram.set(ex.program_id, list);
    }

    const programs: ExportedProgram[] = assignments.map((a) => ({
      assignment_id: a.assignment_id,
      status: a.status,
      assigned_at: a.assigned_at,
      program: { id: a.program_id, name: a.name, description: a.description },
      exercises: byProgram.get(a.program_id) ?? [],
    }));

    // Audit the export in the SAME transaction as the reads.
    await recordGdprEvent(c, {
      tenantId: identity.tenantId,
      action: "export",
      actorRole: isStaff ? "staff" : "member",
      actorUserId: isStaff
        ? await resolveActorUserId(c, identity.userId)
        : null,
      subjectMemberId: memberId,
      detail: {
        programs: programs.length,
        invites: invites.length,
        status_events: statusHistory.length,
      },
    });

    const data: MemberDataExport = {
      format: "alpha-crm.member-export",
      format_version: 1,
      subject: { type: "member", id: member.id },
      member,
      status_history: statusHistory,
      invites,
      programs,
    };
    return { data };
  });
}
