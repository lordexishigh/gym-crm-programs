// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DEMO_ACCOUNTS } from "@/lib/demo-accounts";

// The login forms value-import their `"use server"` action modules, which pull
// server-only code (`@/lib/db`, Supabase, `next/headers`) that cannot load
// here. The forms only need a callable, so a no-op keeps the render pure while
// exercising the real markup — same stubbing as test/a11y.test.ts.
vi.mock("../app/portal/login/actions", () => ({
  memberLoginAction: async () => ({}),
}));
vi.mock("../app/login/actions", () => ({
  loginAction: async () => ({}),
}));

import LandingPage from "../app/page";
import StaffLoginPage from "../app/login/page";
import MemberLoginPage from "../app/portal/login/page";

/**
 * The demo credentials must be ON the screen a visitor is standing on.
 *
 * test/demo-accounts.test.ts pins the credential VALUES to what
 * `scripts/seed.mjs` provisions. This pins their PRESENCE: that each
 * unauthenticated entry surface actually renders the accounts it accepts.
 *
 * The gap it guards is the one a review keeps finding. This app has no public
 * sign-up — members are invite-only, staff are seeded — so a surface that shows
 * no credentials is a dead end for anyone without out-of-band setup. The
 * landing page has carried the notice for some time, but a tester rarely enters
 * at `/`: a guarded route redirects them to `/login`, and an invite email drops
 * them on `/portal/login`. Credentials one screen behind them are credentials
 * they never see.
 *
 * Rendered to static markup, i.e. the server pass — the same HTML that reaches
 * a browser with JavaScript still loading, or with the database and auth
 * service down, which is exactly when someone goes looking for a way in.
 */
const MEMBER = DEMO_ACCOUNTS.find((a) => a.href === "/portal/login")!;
const STAFF = DEMO_ACCOUNTS.filter((a) => a.href === "/login");

describe("demo credentials are visible on every sign-in surface", () => {
  it("the landing page lists every account", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));
    for (const account of DEMO_ACCOUNTS) {
      expect(html).toContain(account.email);
      expect(html).toContain(account.password);
    }
  });

  it("the staff sign-in page shows the staff accounts", () => {
    const html = renderToStaticMarkup(createElement(StaffLoginPage));
    for (const account of STAFF) {
      expect(html).toContain(account.email);
      expect(html).toContain(account.password);
    }
  });

  it("the member portal sign-in page shows the member account", () => {
    const html = renderToStaticMarkup(createElement(MemberLoginPage));
    expect(html).toContain(MEMBER.email);
    expect(html).toContain(MEMBER.password);
  });

  it("shows each form only the credentials that form accepts", () => {
    // Advertising a staff account on the member form (or the reverse) is worse
    // than showing nothing: the tester enters valid credentials, is rejected,
    // and concludes the login is broken.
    const staffHtml = renderToStaticMarkup(createElement(StaffLoginPage));
    expect(staffHtml).not.toContain(MEMBER.email);

    const memberHtml = renderToStaticMarkup(createElement(MemberLoginPage));
    for (const account of STAFF) {
      expect(memberHtml).not.toContain(account.email);
    }
  });
});
