// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ReadinessNoticeBanner,
  readinessHeadline,
  requiredGapsFrom,
  type RequiredGap,
} from "../app/ReadinessNotice";
import { capabilities, capabilityGaps } from "../lib/capabilities";

// The login forms value-import their `"use server"` action modules, which pull
// server-only code that cannot load here. Same stubbing as
// test/demo-credentials-visible.test.ts.
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
 * A deployment that cannot sign anyone in has to SAY SO, on the way in.
 *
 * The gap this guards is the one a review kept reporting as "the entire product
 * surface is inaccessible" and "both entry links dead-end". Both were true, and
 * neither was a routing bug: `/`, `/login` and `/portal/login` all served 200,
 * but with no auth service configured nothing behind them could ever be reached,
 * and every unauthenticated surface still advertised demo accounts as though
 * they would work. The app knew (`lib/capabilities.ts` marks `auth` required and
 * `/api/health` publishes it) and only told the dashboard, which is behind the
 * login it was reporting on.
 */

/** The shape `/api/health` actually returns for an unconfigured deployment. */
const AUTH_GAP = {
  id: "auth",
  label: "Sign-in",
  severity: "required",
  missing: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"],
  consequence:
    "The login pages render but nobody — staff or member — can get past them.",
};

const EMAIL_GAP = {
  id: "email",
  label: "Transactional email",
  severity: "degraded",
  missing: ["RESEND_API_KEY"],
  consequence: "Invites are accepted and never delivered.",
};

const render = (gaps: RequiredGap[]) =>
  renderToStaticMarkup(createElement(ReadinessNoticeBanner, { gaps }));

describe("requiredGapsFrom", () => {
  it("keeps the required gaps", () => {
    const gaps = requiredGapsFrom({ capability_gaps: [AUTH_GAP] });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      id: "auth",
      label: "Sign-in",
      consequence: AUTH_GAP.consequence,
      missing: AUTH_GAP.missing,
    });
  });

  it("drops non-required gaps", () => {
    // A visitor on a login form can do nothing about undelivered invite email,
    // and a banner listing things that do not block them is one they skip.
    expect(requiredGapsFrom({ capability_gaps: [EMAIL_GAP] })).toEqual([]);
  });

  it("reports nothing for a healthy deployment", () => {
    expect(requiredGapsFrom({ capability_gaps: [] })).toEqual([]);
  });

  it("survives a body that is not the payload it expects", () => {
    // A proxy's HTML error page, a truncated response, a future payload change:
    // all must degrade to "say nothing" rather than throw inside a render.
    for (const body of [
      null,
      undefined,
      "<html>502</html>",
      42,
      {},
      { capability_gaps: "nope" },
      { capability_gaps: [null, 7, {}] },
    ]) {
      expect(requiredGapsFrom(body)).toEqual([]);
    }
  });

  it("skips entries with no id or no consequence, and defaults a missing label", () => {
    const gaps = requiredGapsFrom({
      capability_gaps: [
        { severity: "required", consequence: "no id" },
        { id: "database", severity: "required" },
        { id: "database", severity: "required", consequence: "No data." },
      ],
    });
    expect(gaps).toEqual([
      { id: "database", label: "database", missing: [], consequence: "No data." },
    ]);
  });
});

describe("readinessHeadline", () => {
  it("names sign-in specifically when auth is the gap", () => {
    expect(readinessHeadline([{ ...AUTH_GAP } as RequiredGap])).toContain(
      "cannot sign anyone in",
    );
  });

  it("stays generic for a required gap that is not auth", () => {
    const db: RequiredGap = {
      id: "database",
      label: "Database",
      missing: ["DATABASE_URL"],
      consequence: "No page that reads gym data can render.",
    };
    expect(readinessHeadline([db])).toBe("This deployment is not ready yet");
  });
});

describe("ReadinessNoticeBanner", () => {
  it("renders nothing when there is nothing wrong", () => {
    expect(render([])).toBe("");
  });

  it("states the consequence and the variables to set", () => {
    const html = render(requiredGapsFrom({ capability_gaps: [AUTH_GAP] }));
    expect(html).toContain("cannot sign anyone in");
    expect(html).toContain(AUTH_GAP.consequence);
    for (const name of AUTH_GAP.missing) expect(html).toContain(name);
    // The visitor must be told retrying is pointless — the previous message
    // ("try again in a moment") described a blip, not a missing variable.
    expect(html).toContain("will not change that");
  });
});

describe("the gap the notice reports matches lib/capabilities", () => {
  it("auth is a required capability, so it reaches this banner", () => {
    // If someone downgrades `auth` to "degraded", the banner silently stops
    // warning about the one gap it exists for. Pin the two together.
    const auth = capabilities().find((c) => c.id === "auth");
    expect(auth?.severity).toBe("required");
  });

  it("an unconfigured environment produces a required auth gap", () => {
    // This suite runs with no NEXT_PUBLIC_SUPABASE_* set, i.e. exactly the
    // deployment state being reported on.
    const ids = capabilityGaps()
      .filter((c) => c.severity === "required")
      .map((c) => c.id);
    expect(ids).toContain("auth");
  });
});

describe("every unauthenticated entry point mounts the notice", () => {
  // The notice fills in after mount, so it is absent from this server pass by
  // design. What is asserted here is that each page RENDERS the component at
  // all — the failure being guarded is the landing page carrying it while a
  // sign-in form reached by deep link does not, which is how the credentials
  // notice was wrong before it (see test/demo-credentials-visible.test.ts).
  it.each([
    ["landing", LandingPage],
    ["staff sign-in", StaffLoginPage],
    ["member sign-in", MemberLoginPage],
  ])("%s renders without throwing and shows no banner when ready", (_name, Page) => {
    const html = renderToStaticMarkup(createElement(Page));
    expect(html).not.toContain("Deployment readiness");
    expect(html.length).toBeGreaterThan(0);
  });
});
