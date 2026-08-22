/**
 * What each staff role is allowed to do.
 *
 * WHY THIS IS A TABLE AND NOT A SCATTER OF `role === "owner"` CHECKS
 *
 * The product has three staff personas — Gym Owner, Trainer, Front Desk — and
 * they differ by WORKFLOW, not by seniority. Front Desk runs the door: check
 * people in, find a member, confirm when they last trained. They do not author
 * programs, they must not see payment records, and they must not be able to
 * touch staff accounts. Encoding that as inline role comparisons at each call
 * site is how a role ends up half-enforced: one page remembers the check, the
 * Server Action behind it does not, and the gate is decorative.
 *
 * So the matrix lives here, once, and every guard reads it. Adding a capability
 * forces a decision for all three roles (the `Record` is exhaustive), and a new
 * role cannot be introduced without answering the same question for every
 * capability.
 *
 * Deliberately PURE: no database, no env, no `lib/db` import — so it is safe in
 * a client bundle (see the `lib` modules note in lib/member-photo.ts) and can be
 * unit-tested as a plain table. Enforcement lives in `lib/auth/session.ts`
 * (`requireCapability`), with Postgres RLS as the backstop for the sensitive
 * tables (migrations/0027_front_desk_role.sql) — this module only says what the
 * rules ARE.
 */

/** The staff job roles stored in `users.role`. */
export type StaffRole = "owner" | "trainer" | "front_desk";

export const STAFF_ROLES: readonly StaffRole[] = [
  "owner",
  "trainer",
  "front_desk",
] as const;

/** The least-privileged role — the safe answer when a role cannot be resolved. */
export const LEAST_PRIVILEGED_STAFF_ROLE: StaffRole = "front_desk";

/** Human labels for the dashboard and the staff picker. */
export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  owner: "Owner",
  trainer: "Trainer",
  front_desk: "Front desk",
};

/**
 * A named thing a staff member can do. Coarse on purpose: one entry per
 * product surface a role either has or has not, rather than one per action —
 * finer granularity than the roles themselves would be unenforceable in
 * practice.
 */
export type StaffCapability =
  /** Run the check-in kiosk (PIN/QR scan in and out). */
  | "checkin"
  /** See the roster, a member's profile, and their attendance history. */
  | "members.read"
  /** Create/edit member records. */
  | "members.write"
  /** Send, resend and revoke member portal invites. */
  | "invites.manage"
  /** See the class schedule and its bookings. */
  | "classes.read"
  /** Schedule/edit classes and promote from the waitlist. */
  | "classes.write"
  /** Open the program builder, templates and the exercise library. */
  | "programs.read"
  /** Author programs, templates and library exercises; assign programs. */
  | "programs.write"
  /** See membership plans, subscriptions and payment records. */
  | "payments.read"
  /** Export or erase a member's personal data (GDPR rights). */
  | "gdpr.manage"
  /** Manage staff accounts and their roles. */
  | "staff.manage";

/**
 * The matrix. Every role names every capability it holds; anything absent is
 * denied. Written as explicit sets rather than "owner gets everything" so the
 * owner row is auditable at a glance too.
 */
const CAPABILITIES: Record<StaffRole, readonly StaffCapability[]> = {
  owner: [
    "checkin",
    "members.read",
    "members.write",
    "invites.manage",
    "classes.read",
    "classes.write",
    "programs.read",
    "programs.write",
    "payments.read",
    "gdpr.manage",
    "staff.manage",
  ],
  // Unchanged from the pre-existing owner/trainer split: a trainer runs
  // training and membership, but never sees revenue and never administers
  // staff.
  trainer: [
    "checkin",
    "members.read",
    "members.write",
    "invites.manage",
    "classes.read",
    "classes.write",
    "programs.read",
    "programs.write",
    "gdpr.manage",
  ],
  // The door, and only the door. Front desk can check a member in, find them,
  // keep their contact details straight and see who is booked into today's
  // classes. Programs, money and staff administration are all closed.
  front_desk: ["checkin", "members.read", "members.write", "classes.read"],
};

/** Whether `role` holds `capability`. */
export function staffCan(role: StaffRole, capability: StaffCapability): boolean {
  return CAPABILITIES[role].includes(capability);
}

/** Every capability `role` holds (copy; the table itself stays immutable). */
export function capabilitiesOf(role: StaffRole): StaffCapability[] {
  return [...CAPABILITIES[role]];
}

/** Narrow an arbitrary string (a `users.role` value) to a known staff role. */
export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === "string" && (STAFF_ROLES as readonly string[]).includes(value);
}
