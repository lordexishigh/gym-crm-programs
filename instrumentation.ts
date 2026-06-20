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
  // No global setup needed today (the logger/monitoring modules are lazy).
  // Present so future tracing/metrics init has a home.
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
