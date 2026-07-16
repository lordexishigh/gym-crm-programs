/**
 * Canonical public base URL of this deployment.
 *
 * Alpha CRM is a single hosted multi-tenant app, so there is exactly one public
 * origin per environment. It comes from `APP_BASE_URL` (the same variable the
 * invite-email links use — see lib/invites.ts and .env.example) with the usual
 * localhost fallback for development, and any trailing slash stripped so
 * callers can safely append paths.
 */
export function siteBaseUrl(): string {
  return (process.env.APP_BASE_URL || "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
}
