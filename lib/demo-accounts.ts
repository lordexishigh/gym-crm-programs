/**
 * The demo accounts `npm run seed` creates, described once.
 *
 * WHY THIS EXISTS
 *
 * The app has no public sign-up: members are invite-only and staff accounts are
 * created by `scripts/seed.mjs`. So a first-time evaluator or QA tester who
 * opens the landing page has no way to get past the login screen without going
 * and reading a script — which is exactly the gap an automated review reported
 * ("no visible demo/seed account notice; a tester cannot get in without
 * out-of-band setup"). The landing page renders this list so the credentials are
 * on the first screen a visitor sees.
 *
 * DRIFT IS THE RISK, so this is not a second copy of the credentials in prose.
 * `scripts/seed.mjs` is the thing that actually provisions these accounts, and
 * it cannot import this module (it is plain Node, run before/without a build,
 * and this is TypeScript). Rather than let the two silently disagree — a notice
 * advertising a password that no longer works is worse than no notice at all —
 * test/demo-accounts.test.ts asserts that every entry below matches the
 * corresponding default literal in `scripts/seed.mjs`, so a change to one that
 * is not mirrored in the other fails the suite.
 *
 * These are DEMO credentials for a seeded demo tenant, deliberately public:
 * publishing them is the feature. They are the `SEED_*` defaults, so an operator
 * who overrides those (or runs with `SEED_DEMO_DATA=0` for a real gym) is
 * running a different set — see `DEMO_ACCOUNTS_CAVEAT`.
 *
 * Kept free of any `lib/db` import so it stays safe for client bundles.
 */

export type DemoAccount = {
  /** Who this account represents, in the product's own vocabulary. */
  role: string;
  email: string;
  password: string;
  /** Where these credentials are entered. */
  href: "/login" | "/portal/login";
  /** Human name for that entry point. */
  surface: string;
  /** What this account is worth signing in as — why a tester would pick it. */
  blurb: string;
};

/**
 * Ordered most-useful-first for someone evaluating the product. The member
 * leads: the wedge is a member opening an assigned program on the portal, and
 * the seed ships that end state ready to walk (an assigned program, an active
 * plan), so it is the account that shows the product working with one login.
 */
export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    role: "Member",
    email: "member@demo.local",
    password: "DemoMember!2026",
    href: "/portal/login",
    surface: "Member portal",
    blurb: "Opens the mobile portal with a program already assigned and an active plan.",
  },
  {
    role: "Trainer",
    email: "trainer@demo.local",
    password: "DemoTrainer!2026",
    href: "/login",
    surface: "Staff dashboard",
    blurb: "Builds programs and assigns them to members.",
  },
  {
    role: "Front desk",
    email: "frontdesk@demo.local",
    password: "DemoDesk!2026",
    href: "/login",
    surface: "Staff dashboard",
    blurb:
      "Checks members in and looks up their visits — no program builder, plans or staff admin.",
  },
  {
    role: "Owner",
    email: "owner@demo.local",
    password: "DemoOwner!2026",
    href: "/login",
    surface: "Staff dashboard",
    blurb: "Full access, including billing, plans and staff.",
  },
] as const;

/**
 * The honest footnote. The accounts exist only where the seed has been run, and
 * an operator bootstrapping a REAL gym is told to override the `SEED_*` defaults
 * — so the notice must not claim these always work.
 */
export const DEMO_ACCOUNTS_CAVEAT =
  "Seeded by `npm run seed` on demo environments. Credentials differ wherever the SEED_* defaults were overridden.";
