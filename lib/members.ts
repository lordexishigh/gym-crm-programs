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
  created_at: string;
  updated_at: string;
};

export type MemberStatus = "active" | "inactive";

/** Normalised, validated values ready to persist. */
export type MemberInput = {
  fullName: string;
  /** Null when left blank — the columns are nullable. */
  email: string | null;
  phone: string | null;
  status: MemberStatus;
  notes: string | null;
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

  return { ok: true, value: { fullName, email, phone, status: statusRaw, notes } };
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
