import { createHash, randomBytes } from "node:crypto";

/**
 * Invite token generation + verification (mvp-member-management-003/004).
 *
 * The onboarding link carries a high-entropy RAW token; the database only ever
 * stores its SHA-256 hash (`invite.token_hash`). This means a leaked DB row
 * cannot be turned back into a working link, and verification is a constant
 * lookup by hash. Single-use and expiry are enforced by the invite row's
 * `status`/`expires_at` (checked in the acceptance path), not by the token
 * itself.
 *
 * Pure + dependency-free (only node:crypto) so it is unit-testable without a DB.
 */

/** How long a freshly-issued invite stays valid. */
export const INVITE_TTL_DAYS = 7;

export type GeneratedInvite = {
  /** The secret to embed in the onboarding link. Never stored. */
  token: string;
  /** SHA-256 hex digest of `token` — this is what goes in `invite.token_hash`. */
  tokenHash: string;
};

/** Hash a raw token to the value stored/looked-up in `invite.token_hash`. */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Generate a new single-use invite token and its stored hash. */
export function generateInviteToken(): GeneratedInvite {
  // 32 bytes → 256 bits of entropy; base64url is URL-safe (no +/= to escape).
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInviteToken(token) };
}

/**
 * True when an invite with the given expiry is past it. A null expiry means
 * "never expires" (defensive — issuance always sets one). `now` is injectable
 * for testing.
 */
export function isInviteExpired(
  expiresAt: Date | string | null,
  now: Date = new Date(),
): boolean {
  if (!expiresAt) return false;
  const exp = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  return exp.getTime() <= now.getTime();
}

/**
 * Build the absolute onboarding link for an invite. Base URL comes from
 * `APP_BASE_URL` (falls back to localhost in dev). The token is passed as a
 * query param the acceptance page reads.
 */
export function inviteAcceptUrl(token: string): string {
  const base = (process.env.APP_BASE_URL || "http://localhost:3000").replace(
    /\/$/,
    "",
  );
  return `${base}/invite/accept?token=${encodeURIComponent(token)}`;
}
