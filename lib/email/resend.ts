/**
 * Transactional email via Resend (mvp-member-management-002).
 *
 * A thin, dependency-free `fetch` wrapper over the Resend HTTP API — same shape
 * as the GoTrue client in lib/auth/supabase.ts: it returns a discriminated
 * result and NEVER throws, so a send failure is a value the caller handles
 * rather than a crash mid-request.
 *
 * Credentials come from the environment:
 *   RESEND_API_KEY    server-only API key (a sandbox key in dev).
 *   INVITE_FROM_EMAIL the verified sender, e.g. "Alpha CRM <noreply@…>".
 *
 * Deliverability hardening (SPF/DKIM, bounce handling) is deferred to Beta.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type EmailMessage = {
  to: string | string[];
  subject: string;
  html: string;
  /** Optional plain-text fallback (recommended for deliverability). */
  text?: string;
};

/**
 * Why a send failed, in the terms a CALLER has to act on.
 *
 * The distinction that matters is `not_configured` versus everything else. A
 * deployment with no mail provider is a permanent, operator-level gap: retrying
 * cannot help, and the caller's only useful move is to fall back to a delivery
 * channel that does not need email (see `sendInviteAction`, which surfaces the
 * onboarding link for staff to pass on by hand). A `unreachable`/`rejected`
 * failure is transient or address-specific — worth alerting on and worth
 * retrying, which is a different response entirely.
 */
export type SendFailureReason = "not_configured" | "unreachable" | "rejected";

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; error: string; reason: SendFailureReason };

type ResendResponse = {
  id?: string;
  message?: string;
  name?: string;
};

function emailConfig(): { apiKey: string; from: string } | null {
  // Trimmed so a whitespace-only variable — a half-filled `.env`, a CI secret
  // that resolved to "" — counts as unset rather than producing a request that
  // the provider rejects with an opaque 401.
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.INVITE_FROM_EMAIL?.trim();
  if (!apiKey || !from) return null;
  return { apiKey, from };
}

/**
 * Whether this deployment can send email at all.
 *
 * Exported so a caller can tell staff what will happen BEFORE they press a
 * button, rather than only after a send has already failed.
 */
export function isEmailConfigured(): boolean {
  return emailConfig() !== null;
}

/**
 * Send a transactional email. Returns `{ ok: false, error }` on a missing-config,
 * network, or non-2xx provider error instead of throwing.
 */
export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  const config = emailConfig();
  if (!config) {
    return {
      ok: false,
      reason: "not_configured",
      error:
        "Email delivery is not configured on this deployment " +
        "(RESEND_API_KEY and INVITE_FROM_EMAIL — see .env.example).",
    };
  }
  const { apiKey, from } = config;

  let res: Response;
  try {
    res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(message.to) ? message.to : [message.to],
        subject: message.subject,
        html: message.html,
        ...(message.text ? { text: message.text } : {}),
      }),
      // Transactional sends must never be cached.
      cache: "no-store",
    });
  } catch {
    return {
      ok: false,
      reason: "unreachable",
      error: "Could not reach the email service.",
    };
  }

  let body: ResendResponse;
  try {
    body = (await res.json()) as ResendResponse;
  } catch {
    body = {};
  }

  if (!res.ok || !body.id) {
    return {
      ok: false,
      reason: "rejected",
      error: body.message || `Email send failed (HTTP ${res.status}).`,
    };
  }
  return { ok: true, id: body.id };
}
