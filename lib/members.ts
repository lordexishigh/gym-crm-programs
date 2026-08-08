/**
 * Member record shapes + input validation (mvp-member-management-001,
 * extended by alpha-member-records-001/002).
 *
 * Validation is a PURE function (no DB, no env) so it can run in the Server
 * Action before any query and be unit-tested in isolation. The database still
 * enforces the hard invariants (full_name NOT NULL, status CHECK, and RLS
 * tenant scoping) — this layer gives the staff user friendly, field-level
 * errors before a round-trip. The roster helpers below are likewise pure: they
 * build the WHERE clause + bound parameters for the search/filter list, leaving
 * the actual query (and RLS tenant scoping) to the page.
 */

/** A member row as read by the staff dashboard (tenant-scoped via RLS). */
export type MemberRow = {
  id: string;
  email: string | null;
  full_name: string;
  phone: string | null;
  status: MemberStatus;
  notes: string | null;
  auth_user_id: string | null;
  photo_url: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  membership_status: MembershipStatus;
  created_at: string;
  updated_at: string;
};

export type MemberStatus = "active" | "inactive";

/** Billing/renewal lifecycle — distinct from the roster `status` above. */
export type MembershipStatus = "active" | "expired" | "frozen" | "cancelled";

export const MEMBERSHIP_STATUSES: MembershipStatus[] = [
  "active",
  "expired",
  "frozen",
  "cancelled",
];

/** Normalised, validated values ready to persist. */
export type MemberInput = {
  fullName: string;
  /** Null when left blank — the columns are nullable. */
  email: string | null;
  phone: string | null;
  status: MemberStatus;
  notes: string | null;
  photoUrl: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  membershipStatus: MembershipStatus;
};

export type ValidationResult =
  | { ok: true; value: MemberInput }
  | { ok: false; error: string };

// Pragmatic email shape check (the real authority is the provider at send time).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Lenient phone check: digits plus the usual separators, no letters.
const PHONE_RE = /^[+()\-.\s0-9]{4,40}$/;
const NOTES_MAX = 2000;

/**
 * Validate + normalise raw form values into a `MemberInput`.
 *
 * Rules:
 *   - full_name is REQUIRED (matches the NOT NULL column).
 *   - email is optional, but when present must look like an email. A member
 *     cannot be *invited* without one, but can be recorded without one.
 *   - phone is optional; when present it must look like a phone number.
 *   - notes are optional free text, capped at a sane length.
 *   - status defaults to "active" and must be one of the allowed values.
 */
export function validateMemberInput(raw: {
  fullName?: unknown;
  email?: unknown;
  phone?: unknown;
  status?: unknown;
  notes?: unknown;
  photoUrl?: unknown;
  emergencyContactName?: unknown;
  emergencyContactPhone?: unknown;
  membershipStatus?: unknown;
}): ValidationResult {
  const fullName = typeof raw.fullName === "string" ? raw.fullName.trim() : "";
  if (!fullName) {
    return { ok: false, error: "Full name is required." };
  }
  if (fullName.length > 200) {
    return { ok: false, error: "Full name is too long (max 200 characters)." };
  }

  const emailRaw =
    typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  const email = emailRaw.length > 0 ? emailRaw : null;
  if (email && !EMAIL_RE.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  const phoneRaw = typeof raw.phone === "string" ? raw.phone.trim() : "";
  const phone = phoneRaw.length > 0 ? phoneRaw : null;
  if (phone && !PHONE_RE.test(phone)) {
    return { ok: false, error: "Enter a valid phone number." };
  }

  const statusRaw = typeof raw.status === "string" ? raw.status : "active";
  if (statusRaw !== "active" && statusRaw !== "inactive") {
    return { ok: false, error: "Status must be active or inactive." };
  }

  const notesRaw = typeof raw.notes === "string" ? raw.notes.trim() : "";
  if (notesRaw.length > NOTES_MAX) {
    return { ok: false, error: `Notes are too long (max ${NOTES_MAX} characters).` };
  }
  const notes = notesRaw.length > 0 ? notesRaw : null;

  const photoUrlRaw = typeof raw.photoUrl === "string" ? raw.photoUrl.trim() : "";
  if (photoUrlRaw.length > 0 && !isHttpUrl(photoUrlRaw)) {
    return { ok: false, error: "Photo URL must be a valid http(s) link." };
  }
  const photoUrl = photoUrlRaw.length > 0 ? photoUrlRaw : null;

  const ecNameRaw =
    typeof raw.emergencyContactName === "string" ? raw.emergencyContactName.trim() : "";
  if (ecNameRaw.length > 200) {
    return { ok: false, error: "Emergency contact name is too long (max 200 characters)." };
  }
  const emergencyContactName = ecNameRaw.length > 0 ? ecNameRaw : null;

  const ecPhoneRaw =
    typeof raw.emergencyContactPhone === "string" ? raw.emergencyContactPhone.trim() : "";
  if (ecPhoneRaw.length > 0 && !PHONE_RE.test(ecPhoneRaw)) {
    return { ok: false, error: "Enter a valid emergency contact phone number." };
  }
  const emergencyContactPhone = ecPhoneRaw.length > 0 ? ecPhoneRaw : null;

  const membershipStatusRaw =
    typeof raw.membershipStatus === "string" ? raw.membershipStatus : "active";
  if (!MEMBERSHIP_STATUSES.includes(membershipStatusRaw as MembershipStatus)) {
    return { ok: false, error: "Membership status is not valid." };
  }
  const membershipStatus = membershipStatusRaw as MembershipStatus;

  return {
    ok: true,
    value: {
      fullName,
      email,
      phone,
      status: statusRaw,
      notes,
      photoUrl,
      emergencyContactName,
      emergencyContactPhone,
      membershipStatus,
    },
  };
}

// Pragmatic http(s) URL check for a pasted photo link (avatar hosting, cloud
// storage, etc.) — same "trust but keep tidy" spirit as EMAIL_RE/PHONE_RE.
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Roster search / filter / pagination (alpha-member-records-002).

/** How many members to show per roster page. */
export const ROSTER_PAGE_SIZE = 20;

/** Status filter values accepted on the roster, "all" meaning no filter. */
export type StatusFilter = MemberStatus | "all";

export type RosterFilters = {
  /** Trimmed name search term ("" when none). */
  q: string;
  status: StatusFilter;
  /** 1-based page number (always >= 1). */
  page: number;
};

/**
 * Parse raw query-string values (all `string | undefined` from searchParams)
 * into validated roster filters. Unknown/invalid values fall back to defaults
 * so a hand-edited URL can never break the query.
 */
export function parseRosterFilters(raw: {
  q?: unknown;
  status?: unknown;
  page?: unknown;
}): RosterFilters {
  const q = typeof raw.q === "string" ? raw.q.trim() : "";

  const statusRaw = typeof raw.status === "string" ? raw.status : "all";
  const status: StatusFilter =
    statusRaw === "active" || statusRaw === "inactive" ? statusRaw : "all";

  const pageNum = typeof raw.page === "string" ? Number.parseInt(raw.page, 10) : NaN;
  const page = Number.isFinite(pageNum) && pageNum >= 1 ? Math.floor(pageNum) : 1;

  return { q, status, page };
}

// Escape LIKE/ILIKE wildcards so a search term is matched literally. Pairs with
// an explicit `escape '\'` in the query below.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Build the shared WHERE clause + bound params for the roster query from the
 * given filters. Param placeholders start at `$1`; the caller appends limit /
 * offset placeholders after `params.length`. No tenant predicate is added —
 * RLS (`member_staff_all`) scopes rows to the current gym.
 */
export function memberRosterWhere(filters: RosterFilters): {
  clause: string;
  params: unknown[];
} {
  const conds: string[] = [];
  const params: unknown[] = [];

  if (filters.q) {
    params.push(`%${escapeLike(filters.q)}%`);
    conds.push(`full_name ilike $${params.length} escape '\\'`);
  }
  if (filters.status !== "all") {
    params.push(filters.status);
    conds.push(`status = $${params.length}`);
  }

  const clause = conds.length > 0 ? `where ${conds.join(" and ")}` : "";
  return { clause, params };
}

/** Total number of pages for `total` matching rows (always >= 1). */
export function rosterPageCount(total: number, pageSize = ROSTER_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * A roster row: the member profile plus the at-a-glance engagement signal
 * (review-hardening-roster-engagement-001). The engagement columns come from a
 * single aggregate join (see `rosterListSql`), not a per-row query.
 */
export type RosterMemberRow = MemberRow & {
  /** Most recent logged session ever, or null if the member never logged. */
  last_completed_at: string | null;
  /** Sessions logged inside the adherence window (0 when none / never). */
  recent_sessions: number;
  /**
   * When the member's uploaded photo last changed, or null when they have none.
   * Presence-and-version only — the bytes are served separately (see
   * `memberAvatarSrc` in lib/member-photo.ts).
   */
  photo_updated_at: string | null;
};

/**
 * Build the roster list query: the member columns plus a per-member workout
 * aggregate, joined ONCE (no N+1). `clause` is the shared WHERE from
 * `memberRosterWhere`, occupying placeholders `$1..$paramCount`; the caller then
 * binds the adherence window, page limit and offset as the next three params
 * ($paramCount+1, +2, +3) in that order.
 *
 * No tenant predicate is added: RLS scopes every side — `member_staff_all` for
 * the member rows, `workout_log_staff_select` for the aggregate, and
 * `member_photo_staff_all` for the avatar join — to the current gym, so the
 * engagement counts can only ever reflect this tenant's logs.
 *
 * The WHERE columns (`full_name`, `status`) stay unqualified: only `member` (the
 * aliased `m`) exposes them, so they remain unambiguous against the `wl`
 * aggregate (member_id / last_completed_at / recent_sessions) and the `mp` photo
 * join (member_id / tenant_id / content_type / bytes / byte_size / updated_at).
 */
export function rosterListSql(clause: string, paramCount: number): string {
  const win = paramCount + 1;
  const lim = paramCount + 2;
  const off = paramCount + 3;
  return `select m.id, m.email, m.full_name, m.phone, m.status, m.notes,
                m.auth_user_id, m.photo_url, m.emergency_contact_name,
                m.emergency_contact_phone, m.membership_status,
                m.created_at, m.updated_at,
                wl.last_completed_at,
                coalesce(wl.recent_sessions, 0)::int as recent_sessions,
                mp.updated_at as photo_updated_at
           from member m
           -- Photo PRESENCE + version only. The bytea column is deliberately
           -- never selected here: the roster renders <img> tags pointing at the
           -- authenticated photo route, so a 20-row page stays a few kilobytes.
           left join member_photo mp on mp.member_id = m.id
           left join (
             select member_id,
                    max(completed_at) as last_completed_at,
                    count(*) filter (
                      where completed_at >= now() - make_interval(days => $${win})
                    )::int as recent_sessions
               from workout_log
              group by member_id
           ) wl on wl.member_id = m.id
           ${clause}
          order by m.full_name asc
          limit $${lim} offset $${off}`;
}
