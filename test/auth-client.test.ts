import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression guard for the auth client's bounded wait.
 *
 * `fetch` does NOT time out on its own: undici waits ~300s for response headers
 * and the Edge runtime has no request bound at all. So an auth service that
 * accepts the TCP connection and then goes silent (a paused Supabase project, a
 * half-open connection through a load balancer, a DNS black hole) used to hang
 * the request path indefinitely:
 *   - `signInWithPassword` runs in the /login Server Action — the submit button
 *     sits on "Signing in…" forever, with no error and no way back.
 *   - `refreshAccessToken` runs in MIDDLEWARE on every protected request — a
 *     stalled refresh hangs /dashboard and /portal before any page, error
 *     boundary or loading state can render.
 *
 * These tests pin the contract that every auth call settles within its budget
 * and reports a reason, so the failure surfaces as a visible message rather than
 * a spinning browser tab.
 *
 * `fetch` is stubbed with the pathological case exactly: a response that never
 * arrives, aborting only when the caller's own timeout signal fires (which is
 * what a real `fetch` does with `AbortSignal.timeout`).
 */

/** A fetch that never responds; rejects only when the passed signal aborts. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // no bound at all -> the promise never settles
        signal.addEventListener("abort", () => {
          // Real fetch rejects with a DOMException named "TimeoutError".
          const err = new Error("The operation was aborted due to timeout");
          err.name = "TimeoutError";
          reject(err);
        });
      }),
  );
}

/** A fetch that answers immediately with `body` and the given status. */
function respondingFetch(body: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("lib/auth/supabase — bounded auth calls", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://auth.example.test";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
    // Keep the suite fast; read fresh on every call.
    process.env.AUTH_FETCH_TIMEOUT_MS = "120";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AUTH_FETCH_TIMEOUT_MS;
  });

  it("passes an abort signal so a silent auth service cannot hang the caller", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { signInWithPassword } = await import("@/lib/auth/supabase");

    await signInWithPassword("a@b.test", "pw");

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("signInWithPassword resolves with a timeout error instead of hanging", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const { signInWithPassword } = await import("@/lib/auth/supabase");

    const started = Date.now();
    const result = await signInWithPassword("a@b.test", "pw");
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringMatching(/timed out/i) });
    // Settled on its own budget, nowhere near undici's ~300s header timeout.
    expect(elapsed).toBeLessThan(3_000);
  });

  it("refreshAccessToken (runs in middleware) also fails fast", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const { refreshAccessToken } = await import("@/lib/auth/supabase");

    const started = Date.now();
    const result = await refreshAccessToken("refresh-token");

    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("signOut swallows a timeout — clearing cookies is what ends the session", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const { signOut } = await import("@/lib/auth/supabase");

    await expect(signOut("access-token")).resolves.toBeUndefined();
  });

  it("distinguishes an unreachable service from a slow one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { signInWithPassword } = await import("@/lib/auth/supabase");

    const result = await signInWithPassword("a@b.test", "pw");

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/could not reach/i),
    });
  });

  it("honours AUTH_FETCH_TIMEOUT_MS and ignores junk values", async () => {
    process.env.AUTH_FETCH_TIMEOUT_MS = "not-a-number";
    vi.stubGlobal("fetch", hangingFetch());
    const { signInWithPassword } = await import("@/lib/auth/supabase");

    const fast = signInWithPassword("a@b.test", "pw");
    // Junk falls back to the 8s default rather than silently disabling the
    // bound, so this must still be pending well before then.
    const pending = await Promise.race([
      fast.then(() => "settled"),
      new Promise((r) => setTimeout(() => r("pending"), 100)),
    ]);
    expect(pending).toBe("pending");
    await fast; // let it settle so the test does not leak a timer
  }, 15_000);

  it("still returns tokens on a successful sign-in", async () => {
    vi.stubGlobal(
      "fetch",
      respondingFetch({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
      }),
    );
    const { signInWithPassword } = await import("@/lib/auth/supabase");

    const result = await signInWithPassword("a@b.test", "pw");

    expect(result).toEqual({
      ok: true,
      tokens: { accessToken: "at", refreshToken: "rt", expiresIn: 3600 },
    });
  });

  /**
   * A missing auth config must be a MESSAGE, not a throw.
   *
   * `signInWithPassword` is awaited directly inside the /login and /portal/login
   * Server Actions, with no try/catch: a throw escapes the action, so
   * `useActionState` never gets a state and React routes the failure to the
   * nearest error boundary. The visitor sees "Something went wrong" for any
   * credentials at all — the crash the adversarial-input journey looks for,
   * where a visible validation message belongs. `refreshAccessToken` has the
   * same shape in edge middleware, where a throw is a bare 500 across
   * /dashboard and /portal.
   */
  describe("when the auth service is not configured", () => {
    beforeEach(() => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      // The operator's diagnostic goes to the log; keep it out of test output.
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("signInWithPassword resolves with a visible message instead of throwing", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { signInWithPassword } = await import("@/lib/auth/supabase");

      const result = await signInWithPassword("a@b.test", "pw");

      expect(result.ok).toBe(false);
      // Readable and non-technical: the visitor cannot fix an env var, and the
      // form renders this string verbatim.
      expect(result).toMatchObject({
        error: expect.stringMatching(/temporarily unavailable/i),
      });
      expect(result).not.toMatchObject({
        error: expect.stringMatching(/SUPABASE|env/i),
      });
      // No pointless request to a URL we know we do not have.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refreshAccessToken (edge middleware) fails softly so it can redirect", async () => {
      vi.stubGlobal("fetch", vi.fn());
      const { refreshAccessToken } = await import("@/lib/auth/supabase");

      await expect(refreshAccessToken("rt")).resolves.toMatchObject({ ok: false });
    });

    it("signOut still succeeds — clearing cookies is what ends the session", async () => {
      vi.stubGlobal("fetch", vi.fn());
      const { signOut } = await import("@/lib/auth/supabase");

      await expect(signOut("at")).resolves.toBeUndefined();
    });

    it("treats a whitespace-only variable as unset", async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "   ";
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { signInWithPassword } = await import("@/lib/auth/supabase");

      const result = await signInWithPassword("a@b.test", "pw");

      // Rather than POSTing to `https:///auth/v1/token` and reporting a
      // confusing network error.
      expect(result.ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("still reports invalid credentials without leaking which factor was wrong", async () => {
    vi.stubGlobal(
      "fetch",
      respondingFetch({ error: "invalid_grant", error_description: "Bad" }, 400),
    );
    const { signInWithPassword } = await import("@/lib/auth/supabase");

    const result = await signInWithPassword("a@b.test", "wrong");

    expect(result).toEqual({ ok: false, error: "Invalid email or password." });
  });
});
