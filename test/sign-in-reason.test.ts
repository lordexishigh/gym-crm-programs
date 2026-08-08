// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Read a project source file. Resolved from the runner's cwd (the project root)
 * rather than `import.meta.url`, which is not a `file:` URL under the jsdom
 * environment this suite needs for rendering.
 */
function source(relative: string): Promise<string> {
  return readFile(path.join(process.cwd(), relative), "utf8");
}

/**
 * React escapes apostrophes to `&#x27;` in rendered text, so a message
 * containing one never appears verbatim in the markup. Escape the expectation
 * the same way rather than weakening it to a fragment.
 */
function escaped(text: string): string {
  return text.replace(/'/g, "&#x27;");
}

/**
 * A guard that sends someone back to a sign-in form must say why.
 *
 * The dead end the review found has two halves. The first — sign-in succeeding
 * and the destination then rejecting the session — is closed in the login actions
 * (see test/post-login-redirect.test.ts). This covers the second: every OTHER
 * route back to a login form (session expiry mid-visit, an unfinished invite,
 * middleware finding no usable session) used to land on a blank form with no
 * explanation, which is indistinguishable from sign-in having silently done
 * nothing. So the guards attach a reason and the forms render it.
 */
import {
  ACCOUNT_NOT_LINKED_TO_GYM,
  SIGN_IN_REASON_PARAM,
  signInPathWithReason,
  signInReasonMessage,
} from "../lib/auth/sign-in-reason";

describe("sign-in reason vocabulary", () => {
  it("builds sign-in paths that carry the reason", () => {
    expect(signInPathWithReason("/login", "session-expired")).toBe(
      "/login?reason=session-expired",
    );
    expect(signInPathWithReason("/portal/login", "setup-incomplete")).toBe(
      "/portal/login?reason=setup-incomplete",
    );
  });

  it("resolves a message for each recognised reason", () => {
    expect(signInReasonMessage("session-expired")).toMatch(/session has ended/i);
    expect(signInReasonMessage("setup-incomplete")).toMatch(/invite email/i);
  });

  it("says nothing for an absent, unknown, or crafted value", () => {
    // Nothing to explain on a plain /login visit, and a junk value must not
    // produce an alarming banner — nor reach an Object.prototype member.
    for (const raw of [null, undefined, "", "nonsense", "toString", "constructor"]) {
      expect(signInReasonMessage(raw)).toBeNull();
    }
  });

  it("keeps the not-linked message actionable rather than telling them to retry", () => {
    // Retrying cannot fix a token with no tenant_id; only the gym can.
    expect(ACCOUNT_NOT_LINKED_TO_GYM).toMatch(/contact your gym/i);
    expect(ACCOUNT_NOT_LINKED_TO_GYM).not.toMatch(/try again/i);
  });
});

/* -------------------------------------------------------------------------
 * The guards. `next/headers` has no request to read outside a render, and
 * `redirect` unwinds by throwing — mirror both so the destination is capturable.
 * ---------------------------------------------------------------------- */
const nav = vi.hoisted(() => ({ to: "" }));
class RedirectSignal extends Error {}
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    nav.to = path;
    throw new RedirectSignal(path);
  },
  // Read by SessionNotice; each test sets the query string it wants.
  useSearchParams: () => new URLSearchParams(search.value),
}));

const cookieJar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "sb-access-token" && cookieJar.token
        ? { name, value: cookieJar.token }
        : undefined,
  }),
}));

const search = vi.hoisted(() => ({ value: "" }));

// lib/auth/session imports the staff-role lookup, which pulls `pg`. Neither is
// reached on the no-session paths under test; stub it so the suite stays
// database-free.
vi.mock("@/lib/staff", () => ({ getStaffRole: async () => "owner" }));

import { requireMember, requireStaff } from "../lib/auth/session";

/** Run a guard expected to redirect and return where it sent the visitor. */
async function redirectOf(guard: () => Promise<unknown>): Promise<string> {
  nav.to = "";
  try {
    await guard();
  } catch (err) {
    if (err instanceof RedirectSignal) return nav.to;
    throw err;
  }
  throw new Error("expected the guard to redirect");
}

describe("guards explain the trip back to a sign-in form", () => {
  beforeEach(() => {
    cookieJar.token = undefined;
  });

  it("requireStaff sends a sessionless visitor to /login with a reason", async () => {
    expect(await redirectOf(requireStaff)).toBe("/login?reason=session-expired");
  });

  it("requireMember sends a sessionless visitor to /portal/login with a reason", async () => {
    expect(await redirectOf(requireMember)).toBe(
      "/portal/login?reason=session-expired",
    );
  });

  it("middleware's no-session redirect carries the same reason", async () => {
    // Pinned against the source: middleware is edge-only and cannot be imported
    // here, but its redirect is the most common way a visitor reaches /login.
    const src = await source("middleware.ts");
    expect(src).toContain("SIGN_IN_REASON_PARAM");
    expect(src).toMatch(/searchParams\.set\(\s*SIGN_IN_REASON_PARAM/);
  });
});

/* -------------------------------------------------------------------------
 * The forms. Both login pages value-import their `"use server"` action modules,
 * which pull server-only code — stub them, as test/demo-credentials-visible.ts
 * and test/a11y.test.ts do.
 * ---------------------------------------------------------------------- */
vi.mock("../app/login/actions", () => ({ loginAction: async () => ({}) }));
vi.mock("../app/portal/login/actions", () => ({
  memberLoginAction: async () => ({}),
}));

import StaffLoginPage from "../app/login/page";
import MemberLoginPage from "../app/portal/login/page";
import { SessionNotice } from "../app/SessionNotice";

/** Render a page the way a browser first receives it: the static server pass. */
function markup(page: () => ReactNode, query: string): string {
  search.value = query;
  return renderToStaticMarkup(createElement(page));
}

describe("both sign-in forms render the reason they were given", () => {
  const EXPIRED = escaped(signInReasonMessage("session-expired")!);
  const INCOMPLETE = escaped(signInReasonMessage("setup-incomplete")!);

  it("the staff form shows an expired session", () => {
    expect(markup(StaffLoginPage, `${SIGN_IN_REASON_PARAM}=session-expired`)).toContain(
      EXPIRED,
    );
  });

  it("the member form shows an expired session", () => {
    expect(markup(MemberLoginPage, `${SIGN_IN_REASON_PARAM}=session-expired`)).toContain(
      EXPIRED,
    );
  });

  it("the member form explains an unfinished invite", () => {
    // requireMember's `setup-incomplete` bounce — "sign in again" is the wrong
    // advice here, so the form must say to use the invite link instead.
    expect(
      markup(MemberLoginPage, `${SIGN_IN_REASON_PARAM}=setup-incomplete`),
    ).toContain(INCOMPLETE);
  });

  it("shows no banner on a plain visit", () => {
    const staff = markup(StaffLoginPage, "");
    expect(staff).not.toContain(EXPIRED);
    expect(staff).not.toContain(INCOMPLETE);
    // ...but the form itself is still fully there.
    expect(staff).toContain("Staff sign in");
    expect(markup(MemberLoginPage, "")).toContain("Member sign in");
  });

  it("still shows the demo credentials alongside the banner", () => {
    // The explanation is only useful with a way to act on it: a tester bounced
    // to /login needs the credentials on the SAME screen, not one behind it.
    const html = markup(StaffLoginPage, `${SIGN_IN_REASON_PARAM}=session-expired`);
    expect(html).toContain(EXPIRED);
    expect(html).toContain("owner@demo.local");
  });

  it("renders nothing for an absent or unrecognised reason", () => {
    for (const query of ["", `${SIGN_IN_REASON_PARAM}=nonsense`]) {
      search.value = query;
      expect(renderToStaticMarkup(createElement(SessionNotice))).toBe("");
    }
  });
});

describe("the notice sits inside a Suspense boundary", () => {
  // `useSearchParams` in a statically-rendered route MUST be wrapped in Suspense
  // or `next build` fails outright — and these two routes staying STATIC (no
  // database, no auth service, nothing to time out) is what keeps them reachable
  // when everything behind them is down. Pinned at the source so a future edit
  // that hoists <SessionNotice /> out of the boundary fails here rather than in
  // a release build.
  for (const page of ["app/login/page.tsx", "app/portal/login/page.tsx"]) {
    it(`${page} wraps SessionNotice in Suspense`, async () => {
      expect(await source(page)).toMatch(
        /<Suspense\s+fallback=\{null\}>\s*<SessionNotice\s*\/>\s*<\/Suspense>/,
      );
    });
  }
});
