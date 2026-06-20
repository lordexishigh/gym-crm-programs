/**
 * Member record shapes + input validation (mvp-member-management-001).
 *
 * Validation is a PURE function (no DB, no env) so it can run in the Server
 * Action before any query and be unit-tested in isolation. The database still
 * enforces the hard invariants (full_name NOT NULL, status CHECK, and RLS
 * tenant scoping) — this layer gives the staff user friendly, field-level
 * errors before a round-trip.
 */

/** A member row as read by the staff dashboard (tenant-scoped via RLS). */
export type MemberRow = {
  id: string;
  email: string | null;
  full_name: string;
  status: MemberStatus;
  auth_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export type MemberStatus = "active" | "inactive";

/** Normalised, validated values ready to persist. */
export type MemberInput = {
  fullName: string;
  /** Null when left blank — the column is nullable. */
  email: string | null;
  status: MemberStatus;
};

export type ValidationResult =
  | { ok: true; value: MemberInput }
  | { ok: false; error: string };

// Pragmatic email shape check (the real authority is the provider at send time).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate + normalise raw form values into a `MemberInput`.
 *
 * Rules:
 *   - full_name is REQUIRED (matches the NOT NULL column).
 *   - email is optional, but when present must look like an email. A member
 *     cannot be *invited* without one, but can be recorded without one.
 *   - status defaults to "active" and must be one of the allowed values.
 */
export function validateMemberInput(raw: {
  fullName?: unknown;
  email?: unknown;
  status?: unknown;
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

  const statusRaw = typeof raw.status === "string" ? raw.status : "active";
  if (statusRaw !== "active" && statusRaw !== "inactive") {
    return { ok: false, error: "Status must be active or inactive." };
  }

  return { ok: true, value: { fullName, email, status: statusRaw } };
}
