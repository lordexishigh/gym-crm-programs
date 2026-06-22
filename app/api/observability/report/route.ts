import { NextResponse } from "next/server";
import { captureException } from "@/lib/observability/monitoring";

/**
 * Client-error sink (beta-hardening-001).
 *
 * The `error.tsx` boundaries run in the browser, where they cannot reach the
 * monitoring credentials. They POST a small report here and this server-side
 * handler runs `captureException`, so a client-rendered error is logged and
 * monitored just like a server one. The boundary already carries Next.js'
 * `digest`, which we reuse as the correlation id so the two halves line up.
 *
 * Untrusted input: we accept only a few short string fields and cap their
 * length — never echo a stack trace back, never trust anything for control flow.
 */
export const dynamic = "force-dynamic";

const MAX = 2000;

function clamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, MAX);
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // Malformed body — nothing to record, but don't error the client.
    return new NextResponse(null, { status: 204 });
  }

  // Web Vitals budget breach (beta-polish-a11y-002). The client only POSTs a
  // metric here when it exceeds the mobile performance budget, so record it as a
  // warning (a perf regression, not a crash) on the same monitoring sink.
  if (body.type === "web-vital") {
    const name = clamp(body.name) ?? "unknown";
    const value = typeof body.value === "number" ? body.value : undefined;
    await captureException(
      new Error(`Web Vitals budget exceeded: ${name}`),
      {
        source: "web-vitals",
        severity: "warning",
        metric: name,
        value,
        rating: clamp(body.rating),
        path: clamp(body.path),
      },
    );
    return new NextResponse(null, { status: 204 });
  }

  const message = clamp(body.message) ?? "Client error";
  const digest = clamp(body.digest);

  await captureException(new Error(message), {
    source: "client",
    severity: "error",
    correlationId: digest,
    surface: clamp(body.surface),
    path: clamp(body.path),
  });

  return new NextResponse(null, { status: 204 });
}
