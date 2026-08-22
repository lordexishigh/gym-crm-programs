import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEMO_ACCOUNTS } from "@/lib/demo-accounts";

/**
 * One-click demo sign-in (app/demo-sign-in.ts).
 *
 * Two things are worth pinning here, and they pull in opposite directions.
 *
 * USABILITY: the demo accounts are the only way into this app — there is no
 * public sign-up — and a review found the demo panel linked to an empty form,
 * so acting on it meant hand-copying a password. The button has to actually
 * sign in, for the right surface (member accounts to the portal action, staff
 * accounts to the staff one), or the product stays unreachable behind its own
 * front door.
 *
 * SAFETY: a one-click sign-in must not become a way to authenticate as anything
 * else. The action takes an account IDENTIFIER and looks the credentials up in
 * a fixed server-side list, so a submitted password is not merely ignored by
 * convention — there is no code path that reads one. Both halves are asserted
 * below, because a regression on either turns this from a demo into a hole.
 *
 * The real login actions are mocked: they reach Supabase, `next/headers` and
 * `lib/db`, none of which exist here. What matters is WHICH one is called and
 * WITH WHAT, which is exactly what a spy records.
 */
const loginAction = vi.fn(async () => ({}) as { error?: string });
const memberLoginAction = vi.fn(async () => ({}) as { error?: string });

vi.mock("../app/login/actions", () => ({
  get loginAction() {
    return loginAction;
  },
}));
vi.mock("../app/portal/login/actions", () => ({
  get memberLoginAction() {
    return memberLoginAction;
  },
}));

const { demoSignInAction } = await import("../app/demo-sign-in");

const MEMBER = DEMO_ACCOUNTS.find((a) => a.href === "/portal/login")!;
const STAFF = DEMO_ACCOUNTS.find((a) => a.href === "/login")!;

/** The form the button posts: an account identifier and nothing else. */
function submit(account: string, extra?: Record<string, string>) {
  const data = new FormData();
  data.set("account", account);
  for (const [k, v] of Object.entries(extra ?? {})) data.set(k, v);
  return demoSignInAction({}, data);
}

beforeEach(() => {
  loginAction.mockClear();
  memberLoginAction.mockClear();
});

describe("demo sign-in", () => {
  it("signs a member demo account in through the portal login action", async () => {
    await submit(MEMBER.email);

    expect(memberLoginAction).toHaveBeenCalledTimes(1);
    expect(loginAction).not.toHaveBeenCalled();

    // The credentials come from the seeded list, not from the request.
    const [, form] = memberLoginAction.mock.calls[0] as unknown as [
      unknown,
      FormData,
    ];
    expect(form.get("email")).toBe(MEMBER.email);
    expect(form.get("password")).toBe(MEMBER.password);
  });

  it("signs a staff demo account in through the staff login action", async () => {
    await submit(STAFF.email);

    expect(loginAction).toHaveBeenCalledTimes(1);
    expect(memberLoginAction).not.toHaveBeenCalled();

    const [, form] = loginAction.mock.calls[0] as unknown as [unknown, FormData];
    expect(form.get("email")).toBe(STAFF.email);
    expect(form.get("password")).toBe(STAFF.password);
  });

  it("reuses the real sign-in path rather than establishing a session itself", async () => {
    // Delegation is the whole safety argument: rate limiting, token
    // re-verification, the staff/member audience gate and the destination
    // dry-run all live in those actions. If this ever stopped calling them, the
    // demo would be exercising a code path no real user takes.
    for (const account of DEMO_ACCOUNTS) {
      await submit(account.email);
    }
    expect(loginAction.mock.calls.length + memberLoginAction.mock.calls.length).toBe(
      DEMO_ACCOUNTS.length,
    );
  });

  it("refuses an account that is not in the demo list", async () => {
    const result = await submit("attacker@example.com");

    expect(result.error).toMatch(/isn't available/i);
    expect(loginAction).not.toHaveBeenCalled();
    expect(memberLoginAction).not.toHaveBeenCalled();
  });

  it("refuses a missing or empty account identifier", async () => {
    expect((await demoSignInAction({}, new FormData())).error).toBeTruthy();
    expect((await submit("   ")).error).toBeTruthy();
    expect(loginAction).not.toHaveBeenCalled();
    expect(memberLoginAction).not.toHaveBeenCalled();
  });

  it("ignores a password supplied by the client", async () => {
    // The button posts no password; a crafted request may. It must not be able
    // to influence what is used, or "sign in as the demo owner" would become a
    // password oracle for that account.
    await submit(STAFF.email, { password: "not-the-demo-password" });

    const [, form] = loginAction.mock.calls[0] as unknown as [unknown, FormData];
    expect(form.get("password")).toBe(STAFF.password);
  });

  it("cannot be pointed at an arbitrary account by supplying an email field", async () => {
    const result = await submit("attacker@example.com", {
      email: STAFF.email,
      password: STAFF.password,
    });

    // The `account` field is the only input consulted, so an `email` field
    // alongside it changes nothing.
    expect(result.error).toBeTruthy();
    expect(loginAction).not.toHaveBeenCalled();
    expect(memberLoginAction).not.toHaveBeenCalled();
  });
});
