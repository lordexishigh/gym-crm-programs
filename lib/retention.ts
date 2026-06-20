/**
 * Data-retention configuration (beta-gdpr-002).
 *
 * Retention is the period a member's personal data is kept after they become
 * inactive, before they become eligible for erasure/anonymisation. It is
 * CONFIGURABLE at two levels, most-specific first:
 *   1. Per gym  — gym.data_retention_days (migration 0004), set by an operator.
 *   2. Platform — the DATA_RETENTION_DAYS env var.
 *   3. Fallback — PLATFORM_DEFAULT_RETENTION_DAYS below.
 *
 * These helpers are PURE (the resolver takes its env value as an argument and
 * the cutoff takes `now`), so retention policy can be unit-tested in isolation
 * and the documented behaviour (docs/DATA_RETENTION.md) cannot silently drift.
 */

/** Built-in default retention period: 3 years (in days) after inactivity. */
export const PLATFORM_DEFAULT_RETENTION_DAYS = 1095;

/**
 * Parse a raw retention value (env string, DB integer, or unknown) into a
 * positive integer number of days, or null when absent/invalid. Invalid input
 * is treated as "unset" so a typo can never silently disable retention.
 */
export function parseRetentionDays(raw: unknown): number | null {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(n)) return null;
  const days = Math.floor(n);
  return days >= 1 ? days : null;
}

/**
 * Resolve the effective retention period (in days) for a gym: its per-tenant
 * override if set, else the platform env value, else the built-in default.
 */
export function resolveRetentionDays(
  gymOverrideDays: unknown,
  envValue: unknown = process.env.DATA_RETENTION_DAYS,
): number {
  return (
    parseRetentionDays(gymOverrideDays) ??
    parseRetentionDays(envValue) ??
    PLATFORM_DEFAULT_RETENTION_DAYS
  );
}

/**
 * The cutoff instant: members who became inactive at or before this are past
 * their retention window. Pure — `now` is supplied by the caller.
 */
export function retentionCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
