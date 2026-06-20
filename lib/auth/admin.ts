/**
 * Supabase Auth (GoTrue) ADMIN client — service-role only (mvp-member-management-004).
 *
 * Used solely on the privileged provisioning path: creating a member's auth
 * account when they accept an invite. It talks to GoTrue's admin endpoints with
 * the service-role key, so it must NEVER be imported into client code or the
 * edge middleware. Like lib/auth/supabase.ts it is fetch-based and returns a
 * discriminated result rather than throwing.
 *
 * The member's custom claims (tenant_id / app_role / member_id) are written into
 * `app_metadata`, which GoTrue embeds in the issued JWT and is NOT editable by
 * the end user. The rest of the app reads identity from there (lib/identity.ts).
 */

export type CreatedAuthUser = { id: string };

export type AdminUserResult =
  | { ok: true; user: CreatedAuthUser }
  | { ok: false; error: string; alreadyExists?: boolean };

function adminConfig(): { url: string; serviceKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.example).",
    );
  }
  return { url: url.replace(/\/$/, ""), serviceKey };
}

type AdminUserResponse = {
  id?: string;
  msg?: string;
  message?: string;
  error?: string;
  error_description?: string;
  code?: number;
};

/**
 * Create a confirmed member auth user with the given password and custom
 * claims. `email_confirm: true` skips the email-verification step — the invite
 * link already proved ownership of the address.
 */
export async function createMemberAuthUser(params: {
  email: string;
  password: string;
  claims: { tenant_id: string; member_id: string };
}): Promise<AdminUserResult> {
  let url: string;
  let serviceKey: string;
  try {
    ({ url, serviceKey } = adminConfig());
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Auth is not configured.",
    };
  }

  let res: Response;
  try {
    res = await fetch(`${url}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        email: params.email,
        password: params.password,
        email_confirm: true,
        app_metadata: {
          app_role: "member",
          tenant_id: params.claims.tenant_id,
          member_id: params.claims.member_id,
        },
      }),
      cache: "no-store",
    });
  } catch {
    return { ok: false, error: "Could not reach the authentication service." };
  }

  let body: AdminUserResponse;
  try {
    body = (await res.json()) as AdminUserResponse;
  } catch {
    body = {};
  }

  if (res.ok && body.id) {
    return { ok: true, user: { id: body.id } };
  }

  // GoTrue returns 422 when the email is already registered.
  const message = body.msg || body.message || body.error_description || body.error || "";
  const alreadyExists =
    res.status === 422 || /already.*regist|already.*exist/i.test(message);
  return {
    ok: false,
    error: alreadyExists
      ? "An account with this email already exists. Try signing in instead."
      : message || `Account setup failed (HTTP ${res.status}).`,
    alreadyExists,
  };
}

/**
 * Delete a Supabase auth user by id. Best-effort cleanup used to avoid orphaning
 * a just-created account when the surrounding provisioning step can't complete
 * (e.g. the invite was consumed by a concurrent acceptance). Never throws.
 */
export async function deleteAuthUser(id: string): Promise<void> {
  let url: string;
  let serviceKey: string;
  try {
    ({ url, serviceKey } = adminConfig());
  } catch {
    return;
  }

  try {
    await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      cache: "no-store",
    });
  } catch {
    // best-effort; nothing actionable if cleanup itself fails
  }
}
