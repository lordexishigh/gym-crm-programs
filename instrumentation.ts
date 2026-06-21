/**
 * Next.js instrumentation (beta-hardening-001).
 *
 * `onRequestError` is the framework-level global error hook: Next.js calls it
 * for every uncaught server error — thrown out of a Server Component, Route
 * Handler, or Server Action — across both the Node and Edge runtimes. Routing
 * it through `captureException` means an unexpected failure anywhere on the
 * staff or member surface is logged and monitored centrally, without each call
 * site having to remember to report. The user still sees only a friendly
 * message (the `error.tsx` boundaries); the stack lives in the logs.
 *
 * See: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */

import type { Instrumentation } from "next";

export function register(): void {
  // Apply any pending SQL migrations on boot. The runner is idempotent (it skips
  // files already recorded in schema_migrations), so this is a safe no-op once the
  // database is up to date — but it guarantees a freshly-cloned or newly-migrated
  // schema (e.g. the `app_user` role grant in 0005) is in place before the first
  // request, instead of failing at runtime with "permission denied to set role".
  //
  // Node-runtime only (the Edge runtime can't open a TCP Postgres connection), and
  // opt-out via AUTO_MIGRATE=0 for environments that migrate out-of-band.
  // Node-only block. Next.js statically excludes everything inside an
  // `if (process.env.NEXT_RUNTIME === "nodejs")` guard from the Edge bundle, so
  // node-only modules (child_process / pg / dotenv) are never bundled for Edge —
  // an early `return` would NOT achieve that, since webpack still bundles the rest.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.AUTO_MIGRATE === "0" || process.env.AUTO_MIGRATE === "false") return;
    if (!process.env.DATABASE_URL && !process.env.MIGRATE_DATABASE_URL) return;

    // Run the migration in a CHILD PROCESS (plain Node), not via import:
    //   - keeps `pg`/`dotenv` out of THIS module's bundle entirely, and
    //   - isolates any `pg` connection 'error' event to the child, so a transient
    //     DB drop can never surface as an uncaughtException in the Next server.
    void (async () => {
      try {
        const { spawn } = await import("node:child_process");
        const child = spawn(process.execPath, ["scripts/migrate.mjs"], {
          cwd: process.cwd(),
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout?.on("data", (d) => (out += d.toString()));
        child.stderr?.on("data", (d) => (out += d.toString()));
        child.on("error", (err) =>
          console.error("[instrumentation] auto-migrate could not start:", err),
        );
        child.on("close", (code) => {
          if (code === 0) {
            if (/\+ apply/.test(out)) {
              console.log("[instrumentation] applied pending migration(s) on boot.");
            }
          } else {
            console.error(
              `[instrumentation] auto-migrate exited with code ${code}. ` +
                `Apply migrations manually if login fails (see README).\n${out.slice(-1200)}`,
            );
          }
        });
      } catch (err) {
        console.error("[instrumentation] auto-migrate on boot failed:", err);
      }
    })();
  }
}

export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  // Dynamic import keeps the (Node/Edge) monitoring module out of the
  // instrumentation's own load path until an error actually occurs.
  const { captureException } = await import("./lib/observability/monitoring");

  const digest =
    error && typeof error === "object" && "digest" in error
      ? String((error as { digest?: unknown }).digest ?? "")
      : "";

  await captureException(error, {
    source: "onRequestError",
    severity: "error",
    correlationId: digest || undefined,
    path: request.path,
    method: request.method,
    routerKind: context.routerKind,
    routePath: context.routePath,
    renderSource: context.renderSource,
  });
};
