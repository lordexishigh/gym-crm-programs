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

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

type ResendResponse = {
  id?: string;
  message?: string;
  name?: string;
};

function emailConfig(): { apiKey: string; from: string } {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.INVITE_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error(
      "RESEND_API_KEY and INVITE_FROM_EMAIL must be set (see .env.example).",
    );
  }
  return { apiKey, from };
}

/**
 * Send a transactional email. Returns `{ ok: false, error }` on a missing-config,
 * network, or non-2xx provider error instead of throwing.
 */
export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  let apiKey: string;
  let from: string;
  try {
    ({ apiKey, from } = emailConfig());
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Email is not configured.",
    };
  }

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
    return { ok: false, error: "Could not reach the email service." };
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
      error: body.message || `Email send failed (HTTP ${res.status}).`,
    };
  }
  return { ok: true, id: body.id };
}
