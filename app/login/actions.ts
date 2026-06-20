"use server";

/**
 * Server Action scaffold for sign-in.
 *
 * The real authentication flow (Supabase Auth, server-side JWT verification,
 * and session establishment) is implemented in the `mvp-auth` task. This
 * placeholder exists so the project structure demonstrably supports Server
 * Actions wired to a form. It intentionally performs no authentication.
 */
export type LoginState = { error?: string; ok?: boolean };

export async function loginAction(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();

  if (!email) {
    return { error: "Email is required." };
  }

  // Authentication is enabled in the mvp-auth task. Until then this is a no-op
  // shell that proves Server Actions are wired end-to-end.
  return {
    error: "Sign-in is not enabled yet — authentication ships in mvp-auth.",
  };
}
