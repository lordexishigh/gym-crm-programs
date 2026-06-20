import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InviteList, type InviteListRow } from "../app/dashboard/invites/InviteList";

/**
 * Staff invite-list VIEW tests (alpha-invite-lifecycle-001/002).
 *
 * Proves the dashboard derives and renders the EFFECTIVE invite status — the
 * stored `status` for terminal states, but a still-`pending` row past its
 * `expires_at` shown as `expired`. Rendered to static markup with no session or
 * database and no action controls (renderActions omitted), exactly like
 * test/program-history-view.test.ts.
 */

const invite = (overrides: Partial<InviteListRow> = {}): InviteListRow => ({
  id: "inv-1",
  email: "member@example.com",
  status: "pending",
  expires_at: "2099-01-01T00:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z",
  accepted_at: null,
  member_id: "mem-1",
  member_name: "Alex Member",
  member_auth_user_id: null,
  ...overrides,
});

const render = (invites: InviteListRow[]) =>
  renderToStaticMarkup(createElement(InviteList, { invites }));

describe("InviteList", () => {
  it("renders an accepted invite as 'accepted'", () => {
    const html = render([
      invite({
        id: "a1",
        status: "accepted",
        accepted_at: "2026-02-01T00:00:00.000Z",
      }),
    ]);
    expect(html).toContain(">accepted<");
    expect(html).toContain("1 accepted");
  });

  it("renders a pending, not-yet-expired invite as 'pending'", () => {
    const html = render([
      invite({ id: "p1", status: "pending", expires_at: "2099-01-01T00:00:00.000Z" }),
    ]);
    expect(html).toContain(">pending<");
    expect(html).toContain("1 pending");
  });

  it("renders a pending invite past its expiry as 'expired'", () => {
    const html = render([
      invite({ id: "e1", status: "pending", expires_at: "2020-01-01T00:00:00.000Z" }),
    ]);
    expect(html).toContain(">expired<");
    expect(html).toContain("1 expired");
    // The underlying status is still pending, but it must not display as such.
    expect(html).not.toContain(">pending<");
  });

  it("renders the member name as a link to their detail page", () => {
    const html = render([invite({ member_id: "mem-9", member_name: "Sam" })]);
    expect(html).toContain('href="/dashboard/members/mem-9"');
    expect(html).toContain("Sam");
  });

  it("shows an empty state and zero counts when there are no invites", () => {
    const html = render([]);
    expect(html).toContain("No invites yet");
    expect(html).toContain("0 pending");
  });
});
