import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEMO_ACCOUNTS } from "@/lib/demo-accounts";

/**
 * The landing page advertises demo credentials; `scripts/seed.mjs` is what
 * actually creates those accounts. The two cannot share a module (the seed is
 * plain Node, run without a build), so this suite is the seam that keeps them
 * honest: it reads the seed source and asserts every advertised credential is
 * still one of its defaults.
 *
 * The failure this prevents is quiet and user-facing — a landing page that
 * confidently offers a password the seed no longer sets, which reads to a first-
 * time visitor as "the login is broken".
 */
const SEED_SRC = readFileSync(
  path.join(process.cwd(), "scripts", "seed.mjs"),
  "utf8",
);

/**
 * Pull the fallback out of a `const X = process.env.Y || "default";` line —
 * i.e. the value the seed uses when the environment overrides nothing, which is
 * exactly what the landing page claims.
 */
function seedDefault(constName: string): string | null {
  const match = new RegExp(
    `const\\s+${constName}\\s*=\\s*process\\.env\\.\\w+\\s*\\|\\|\\s*"([^"]*)"`,
  ).exec(SEED_SRC);
  return match ? match[1] : null;
}

describe("demo account notice", () => {
  const expected = [
    { role: "Member", emailConst: "MEMBER_EMAIL", passwordConst: "MEMBER_PASSWORD" },
    { role: "Trainer", emailConst: "TRAINER_EMAIL", passwordConst: "TRAINER_PASSWORD" },
    {
      role: "Front desk",
      emailConst: "FRONT_DESK_EMAIL",
      passwordConst: "FRONT_DESK_PASSWORD",
    },
    { role: "Owner", emailConst: "EMAIL", passwordConst: "PASSWORD" },
  ];

  it("advertises exactly the roles the seed provisions", () => {
    expect(DEMO_ACCOUNTS.map((a) => a.role)).toEqual(expected.map((e) => e.role));
  });

  it.each(expected)(
    "$role credentials match the seed's defaults",
    ({ role, emailConst, passwordConst }) => {
      const account = DEMO_ACCOUNTS.find((a) => a.role === role);
      expect(account, `no ${role} account`).toBeDefined();

      const email = seedDefault(emailConst);
      const password = seedDefault(passwordConst);
      // A null here means the seed was refactored past this parser — fail
      // loudly rather than silently passing on an unread file.
      expect(email, `could not read ${emailConst} from scripts/seed.mjs`).toBeTruthy();
      expect(
        password,
        `could not read ${passwordConst} from scripts/seed.mjs`,
      ).toBeTruthy();

      expect(account!.email).toBe(email);
      expect(account!.password).toBe(password);
    },
  );

  it("sends every account to a sign-in route that exists", () => {
    for (const account of DEMO_ACCOUNTS) {
      expect(["/login", "/portal/login"]).toContain(account.href);
    }
    // The member is a PORTAL login; staff are not. Getting this backwards sends
    // a tester to a form that will reject perfectly valid credentials.
    expect(DEMO_ACCOUNTS.find((a) => a.role === "Member")!.href).toBe("/portal/login");
    expect(DEMO_ACCOUNTS.find((a) => a.role === "Trainer")!.href).toBe("/login");
    expect(DEMO_ACCOUNTS.find((a) => a.role === "Front desk")!.href).toBe("/login");
    expect(DEMO_ACCOUNTS.find((a) => a.role === "Owner")!.href).toBe("/login");
  });
});
