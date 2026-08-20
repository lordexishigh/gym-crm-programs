import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  STAFF_ROLES,
  capabilitiesOf,
  isStaffRole,
  staffCan,
} from "@/lib/permissions";

/**
 * Front Desk Staff role definition and permissions.
 *
 * The blueprint's acceptance criterion is a sentence about what one account can
 * and cannot do: "A Front Desk account can initiate check-in and look up a
 * member's attendance history but cannot open the program builder, view payment
 * records, or access staff management." This suite pins each half of it.
 *
 * Three layers, because a role that is only enforced in one of them is not
 * enforced:
 *   1. the matrix itself (lib/permissions.ts),
 *   2. the guard that reads it (`requireCapability`) — including that a denied
 *      caller is redirected rather than served, and
 *   3. that every dashboard route and Server Action actually goes through that
 *      guard. A gate nobody calls is the failure mode this last group exists to
 *      catch, and it is a source scan precisely because it must hold for routes
 *      no test happens to exercise.
 *
 * The DB-layer backstop (restrictive RLS policies, 0026) is asserted at the end
 * against the migration source: the policies themselves need a live Postgres and
 * run in the RLS suites, but their PRESENCE should fail loudly here if someone
 * removes them.
 */
const REPO = process.cwd();
const source = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

describe("staff capability matrix", () => {
  it("front desk can run the desk: check-in and member lookup", () => {
    expect(staffCan("front_desk", "checkin")).toBe(true);
    expect(staffCan("front_desk", "members.read")).toBe(true);
    expect(staffCan("front_desk", "members.write")).toBe(true);
    expect(staffCan("front_desk", "classes.read")).toBe(true);
  });

  it("front desk cannot open the builder, see payments, or administer staff", () => {
    // Verbatim from the blueprint's "evidence it's done".
    expect(staffCan("front_desk", "programs.read")).toBe(false);
    expect(staffCan("front_desk", "programs.write")).toBe(false);
    expect(staffCan("front_desk", "payments.read")).toBe(false);
    expect(staffCan("front_desk", "staff.manage")).toBe(false);
  });

  it("leaves the pre-existing owner/trainer split untouched", () => {
    expect(staffCan("trainer", "programs.write")).toBe(true);
    expect(staffCan("trainer", "payments.read")).toBe(false);
    expect(staffCan("trainer", "staff.manage")).toBe(false);
    expect(staffCan("owner", "payments.read")).toBe(true);
    expect(staffCan("owner", "staff.manage")).toBe(true);
  });

  it("gives the owner every capability any role has", () => {
    const owner = new Set(capabilitiesOf("owner"));
    for (const role of STAFF_ROLES) {
      for (const capability of capabilitiesOf(role)) {
        expect(owner.has(capability), `owner is missing ${capability}`).toBe(true);
      }
    }
  });

  it("front desk holds strictly fewer capabilities than a trainer", () => {
    const trainer = new Set(capabilitiesOf("trainer"));
    for (const capability of capabilitiesOf("front_desk")) {
      expect(trainer.has(capability), `trainer is missing ${capability}`).toBe(true);
    }
    expect(capabilitiesOf("front_desk").length).toBeLessThan(trainer.size);
  });

  it("rejects a role value the code does not know", () => {
    // `users.role` is a text column; an unrecognised value must never be
    // treated as a role, or a typo becomes an access grant.
    expect(isStaffRole("front_desk")).toBe(true);
    expect(isStaffRole("frontdesk")).toBe(false);
    expect(isStaffRole("superuser")).toBe(false);
    expect(isStaffRole(undefined)).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * The guard. `next/headers` has no request outside a render and `redirect`
 * unwinds by throwing — mirror both, as test/sign-in-reason.test.ts does.
 * ------------------------------------------------------------------------ */
const nav = vi.hoisted(() => ({ to: "" }));
class RedirectSignal extends Error {}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    nav.to = to;
    throw new RedirectSignal(to);
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "sb-access-token" ? { name, value: "a-token" } : undefined,
  }),
}));

// The token is verified for real everywhere else; here we only need claims, and
// verifying would require a live JWKS endpoint.
vi.mock("@/lib/identity", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/identity")>("@/lib/identity");
  return {
    ...actual,
    verifyAccessToken: async () => ({
      sub: "auth-user-1",
      tenant_id: "11111111-1111-1111-1111-111111111111",
      app_role: "staff",
    }),
  };
});

// The role lookup is a DB read (`pg`); the role under test is set per-case.
const seated = vi.hoisted(() => ({ role: "owner" as string }));
vi.mock("@/lib/staff", () => ({ getStaffRole: async () => seated.role }));

import { requireCapability, requireStaff } from "../lib/auth/session";

/** Run a guard expected to redirect and return where it sent the caller. */
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

describe("requireCapability", () => {
  beforeEach(() => {
    seated.role = "owner";
  });

  it("lets a front-desk session through to check-in and member lookup", async () => {
    seated.role = "front_desk";
    await expect(requireCapability("checkin")).resolves.toMatchObject({
      staffRole: "front_desk",
    });
    await expect(requireCapability("members.read")).resolves.toMatchObject({
      staffRole: "front_desk",
    });
  });

  it("bounces a front-desk session off the builder, plans and staff admin", async () => {
    seated.role = "front_desk";
    expect(await redirectOf(() => requireCapability("programs.read"))).toBe(
      "/dashboard?denied=programs.read",
    );
    expect(await redirectOf(() => requireCapability("payments.read"))).toBe(
      "/dashboard?denied=payments.read",
    );
    expect(await redirectOf(() => requireCapability("staff.manage"))).toBe(
      "/dashboard?denied=staff.manage",
    );
  });

  it("still lets a trainer build programs", async () => {
    seated.role = "trainer";
    await expect(requireCapability("programs.write")).resolves.toMatchObject({
      staffRole: "trainer",
    });
  });

  it("pins the job role onto the identity so RLS can see it", async () => {
    // Without this, `app.staff_role` is never stamped and the restrictive
    // policies in 0026 are inert — the DB-layer half of the role disappears.
    seated.role = "front_desk";
    const session = await requireStaff();
    expect(session.identity.staffRole).toBe("front_desk");
  });
});

/* ---------------------------------------------------------------------------
 * Every dashboard entry point goes through a capability guard.
 * ------------------------------------------------------------------------ */
function dashboardEntryPoints(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "page.tsx" || entry.name === "actions.ts") {
        found.push(path.relative(REPO, full).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(REPO, "app", "dashboard"));
  return found;
}

describe("dashboard routes are gated by capability, not by hand", () => {
  // The overview is the destination a denied caller is REDIRECTED to, so it is
  // reachable by every staff role by design and uses the bare staff guard.
  const UNGATED = new Set(["app/dashboard/page.tsx"]);

  it("finds the dashboard entry points at all (guards the scan itself)", () => {
    const files = dashboardEntryPoints();
    expect(files.length).toBeGreaterThan(15);
    expect(files).toContain("app/dashboard/programs/actions.ts");
  });

  it.each(dashboardEntryPoints().filter((f) => !UNGATED.has(f)))(
    "%s asks for a capability",
    (file) => {
      const src = source(file);
      expect(
        /require(Capability|Owner)\(/.test(src),
        `${file} must gate on requireCapability/requireOwner`,
      ).toBe(true);
      // A leftover bare `requireStaff()` next to a guarded one is how a single
      // unguarded Server Action survives in an otherwise-gated file.
      expect(/\brequireStaff\(\)/.test(src), `${file} still calls requireStaff()`).toBe(
        false,
      );
    },
  );
});

/* ---------------------------------------------------------------------------
 * The database-layer backstop.
 * ------------------------------------------------------------------------ */
describe("0026 enforces the role below the application layer", () => {
  const sql = source("migrations/0026_front_desk_role.sql");

  it("allows 'front_desk' in the users.role constraint", () => {
    expect(sql).toContain("users_role_check");
    expect(sql).toMatch(/check \(role in \('owner', 'trainer', 'front_desk'\)\)/);
  });

  it("reads the role from a session GUC the app stamps server-side", () => {
    expect(sql).toContain("app.staff_role");
    expect(sql).toContain("create or replace function app_is_front_desk()");
    // The GUC has to actually be set, or every policy below is dead code.
    expect(source("lib/db.ts")).toContain("set_config('app.staff_role'");
  });

  it("denies front desk every payment table outright", () => {
    for (const table of ["membership_plans", "member_plans", "payment_events"]) {
      expect(sql).toContain(`${table}_front_desk_denied on ${table}`);
    }
  });

  it("denies front desk writes to the program-authoring tables", () => {
    for (const table of [
      "program",
      "exercise",
      "program_assignment",
      "exercise_library",
      "program_template",
      "template_exercise",
    ]) {
      expect(sql).toContain(`'${table}'`);
    }
    expect(sql).toContain("_front_desk_no_insert");
    expect(sql).toContain("_front_desk_no_update");
    expect(sql).toContain("_front_desk_no_delete");
  });

  it("limits front desk to its own users row", () => {
    expect(sql).toContain("users_front_desk_self_only");
    expect(sql).toContain("auth_user_id = app_current_user_id()");
  });
});

describe("the refusal notice", () => {
  it("has a phrase for every capability the guard can refuse", async () => {
    // A missing entry shows no explanation at all for that refusal, which is
    // exactly the silent redirect the notice exists to replace.
    const { REFUSALS } = await import("../app/dashboard/AccessDeniedNotice");
    for (const capability of capabilitiesOf("owner")) {
      expect(REFUSALS[capability], `no phrase for ${capability}`).toBeTruthy();
    }
  });
});
