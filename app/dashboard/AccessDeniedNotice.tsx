import { type StaffCapability } from "@/lib/permissions";

/**
 * Explains why the visitor is looking at the overview instead of the page they
 * asked for.
 *
 * `requireCapability` (lib/auth/session.ts) redirects a staff member who lacks a
 * capability back here. A bare redirect is the worst possible feedback: the URL
 * they typed silently becomes a different page, which reads as a broken link or
 * a lost session rather than as a permission boundary. This says which section
 * was refused, and — the part that matters on a shared gym machine — that the
 * fix is to ask an owner, not to sign in again.
 *
 * Returns null in the normal case, like `CapabilityNotice`.
 */
export const REFUSALS: Record<StaffCapability, string> = {
  checkin: "the check-in kiosk",
  "members.read": "member records",
  "members.write": "editing member records",
  "invites.manage": "portal invites",
  "classes.read": "the class schedule",
  "classes.write": "editing the class schedule",
  "programs.read": "the program builder",
  "programs.write": "authoring programs",
  "payments.read": "plans and payment records",
  "gdpr.manage": "data export and erasure",
  "staff.manage": "staff management",
};

function refusedLabel(denied: string | string[] | undefined): string | null {
  // A repeated query parameter arrives as an array; take the first.
  const key = Array.isArray(denied) ? denied[0] : denied;
  if (!key) return null;
  // Unknown values are ignored rather than echoed — the parameter is
  // user-controlled, and rendering it back would be a reflected-content hole.
  return Object.prototype.hasOwnProperty.call(REFUSALS, key)
    ? REFUSALS[key as StaffCapability]
    : null;
}

export function AccessDeniedNotice({
  denied,
}: {
  denied: string | string[] | undefined;
}) {
  const label = refusedLabel(denied);
  if (!label) return null;

  return (
    <section
      role="status"
      aria-label="Access refused"
      className="flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-5"
    >
      <span
        aria-hidden
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-200/70 text-amber-900"
      >
        <svg
          width={18}
          height={18}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="3" y="11" width="18" height="10" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-amber-900">
          Your role does not have access to {label}
        </h2>
        <p className="text-sm text-amber-800">
          You are signed in correctly — this section is simply not part of your
          role. Ask a gym owner if you need it.
        </p>
      </div>
    </section>
  );
}
