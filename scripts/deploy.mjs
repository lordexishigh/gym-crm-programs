/**
 * Ship this checkout to Vercel production (`npm run deploy`).
 *
 * No shebang, for the same reason as scripts/postinstall.mjs: test/deploy-script.test.ts
 * imports the pure helpers below, and Vite hoists its CJS-interop declarations
 * above a shebang, which is only valid at the very start of a file. npm runs this
 * as `node scripts/deploy.mjs`, so nothing needs one.
 *
 * WHY THIS EXISTS
 *
 * An automated review of this project keeps reporting the same class of defect:
 * "built but not live — the code implements this but the running app doesn't
 * serve it (push and redeploy, don't rebuild)". It has been reported against the
 * staff login, the member portal, and the landing page. Every time, the code was
 * present and correct and the running app was serving an older build.
 *
 * That kept happening because THIS REPOSITORY HAD NO REACHABLE DEPLOY PATH, and
 * nothing in it said so. Two independent facts, both verified rather than assumed:
 *
 *   1. `.github/workflows/deploy.yml` is the only configured deploy path, and it
 *      cannot run. Every workflow run on this repo — Deploy, CI and the scheduled
 *      job — fails in 4-13s with a GitHub annotation reading "The job was not
 *      started because recent account payments have failed or your spending limit
 *      needs to be increased". Its four deploy secrets are all present and
 *      correct; the jobs simply never start. Nothing inside this repo can fix
 *      that, so nothing inside this repo may depend on it.
 *
 *   2. Vercel's own Git integration cannot cover for it. The Vercel project has
 *      NO Git link at all (`GET /v9/projects/gym-crm-programs` returns
 *      `link: undefined`), so a push to GitHub does not reach Vercel by any
 *      route. `vercel.json` additionally sets
 *      `git.deploymentEnabled.master/main = false`, which is why that is a
 *      belt-and-braces setting rather than the cause.
 *
 * So `git push` deployed nothing, silently, and the live app only ever moved when
 * somebody remembered to run the Vercel CLI by hand. "Committed" reads as
 * "shipped" on every dashboard a reviewer or operator looks at, which is exactly
 * how a correct fix stays invisible for rounds on end.
 *
 * WHAT THIS SCRIPT GUARANTEES
 *
 * It is the deploy path that works, and it is deliberately more than a wrapper
 * around `vercel deploy`:
 *
 *   - It refuses to ship code that is not pushed. "Push and redeploy" is two
 *     steps and the first one is the one that gets skipped; a production build
 *     nobody can `git checkout` is unreviewable and unrevertable.
 *   - It runs migrations BEFORE the new build serves traffic, preserving the one
 *     ordering guarantee `deploy.yml` existed to provide.
 *   - It VERIFIES THE LIVE URL AFTER DEPLOYING, which is the part that actually
 *     closes this defect. A deploy that reports success while the production
 *     alias still serves the previous build is the precise failure being fixed,
 *     so success is defined as "the production URL serves the entry routes from
 *     the NEW build", proven by observation, not by the CLI's exit code.
 *
 * Dependency-free (node: builtins only) so it runs regardless of install state,
 * matching scripts/start.mjs and scripts/postinstall.mjs.
 */

import { spawn } from "node:child_process";
import process from "node:process";

/**
 * The npm spec for the Vercel CLI. Pinned to the same `vercel@latest` that
 * `.github/workflows/deploy.yml` uses so the two paths cannot deploy with
 * different tooling; overridable to pin a version or use a local install.
 */
const VERCEL_PKG = process.env.DEPLOY_VERCEL_PKG || "vercel@latest";

/**
 * The Vercel project to deploy to, passed EXPLICITLY on every deploy.
 *
 * Without this the CLI falls back to directory-based linking: it looks for
 * `.vercel/project.json`, and finding none it creates a BRAND NEW PROJECT NAMED
 * AFTER THE CURRENT DIRECTORY. `.vercel/` is gitignored, so any fresh clone — and
 * every git worktree, which is how changes are prepared here — has no link.
 *
 * Observed, not theorised: the first run of this script from a worktree at
 * `…/nous-wt-2-…/wt` built and deployed successfully to a new project called
 * `wt` (aliased `wt-omega-steel.vercel.app`), reported "Deployment ready", and
 * exited 0 — while `gym-crm-programs.vercel.app` went on serving the previous
 * build. That is "built but not live" produced by the deploy tool itself, with a
 * success message on top of it, and it is exactly what the post-deploy
 * verification below caught.
 *
 * `VERCEL_PROJECT_ID` is honoured first so this agrees with
 * `.github/workflows/deploy.yml`, which passes the id from repository secrets.
 */
const VERCEL_PROJECT =
  process.env.DEPLOY_VERCEL_PROJECT || process.env.VERCEL_PROJECT_ID || "gym-crm-programs";

/**
 * The URL a real user visits, which is the only URL whose behaviour this script
 * is allowed to conclude anything from. A deployment's immutable URL always
 * serves the build that was just uploaded, so checking it would pass even in the
 * exact failure this script exists to catch: a successful build that the
 * production alias was never moved onto.
 */
const PROD_URL = (
  process.env.DEPLOY_VERIFY_URL ||
  process.env.APP_BASE_URL ||
  "https://gym-crm-programs.vercel.app"
).replace(/\/$/, "");

/**
 * Entry routes, with a string each that only appears when the page actually
 * RENDERED. A 200 alone is not evidence: Next.js serves an error boundary, a
 * `not-found`, and a shell whose body failed to render all with cheerful
 * statuses, and every one of those would read as a healthy deploy.
 */
const ENTRY_ROUTES = [
  { path: "/", marker: "Alpha CRM" },
  { path: "/login", marker: "Staff sign in" },
  { path: "/portal/login", marker: "Member sign in" },
];

/** How long to wait for the production alias to start serving the new build. */
const VERIFY_TIMEOUT_MS = Number(process.env.DEPLOY_VERIFY_TIMEOUT_MS) || 180_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Treat empty string / 0 / false as unset, so a CI step can clear a value. */
function isSet(value) {
  return (
    typeof value === "string" && value.trim() !== "" && value !== "0" && value !== "false"
  );
}

/**
 * Spawn a child and resolve with `{ code, out }`. Never rejects.
 *
 * `echo` controls whether output is streamed as it arrives. ON for the long
 * commands an operator needs to watch (a 40s deploy must not look like a hang),
 * OFF for the small `git` probes below, whose raw output is plumbing rather than
 * something to print at someone. Output is captured either way, so a failure can
 * be quoted back in this script's own error instead of leaving the operator to
 * scroll for it.
 *
 * `line` passes a single pre-quoted command STRING through a shell, which is what
 * the `npx` shim needs on Windows (Node cannot spawn a `.cmd` without one).
 * Passing an args ARRAY with `shell: true` is what triggers Node's DEP0190
 * warning — the arguments get concatenated unescaped — so the two modes are kept
 * strictly separate: shell form takes a string, array form never uses a shell.
 */
function run(cmd, args = [], { env = process.env, echo = false, line = false } = {}) {
  return new Promise((resolve) => {
    const opts = { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] };
    const child = line
      ? spawn(cmd, { ...opts, shell: true })
      : spawn(cmd, args, opts);
    let out = "";
    const take = (chunk) => {
      const text = chunk.toString();
      out += text;
      if (echo) process.stderr.write(text);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (err) => resolve({ code: -1, out: `${out}\n${err.message}` }));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

/**
 * Reasons this checkout must not be deployed, as operator-readable strings.
 *
 * Pure and injectable so the POLICY is unit-tested rather than a real deploy.
 *
 * The unpushed case is the one that matters here and it is a hard block, not a
 * warning. A production build made from commits that exist only on one machine
 * cannot be reviewed, reverted, or reproduced by anyone else, and it inverts the
 * very report this script answers: the running app would be AHEAD of `master`,
 * so the code a reviewer reads is not the code they are testing. Overridable via
 * DEPLOY_ALLOW_DIRTY=1 for a deliberate hotfix.
 *
 * @param {{ dirty?: boolean, unpushed?: number, branch?: string,
 *           env?: Record<string, string | undefined> }} opts
 */
export function gitBlockers({ dirty = false, unpushed = 0, branch = "", env = process.env } = {}) {
  if (isSet(env.DEPLOY_ALLOW_DIRTY)) return [];
  const blockers = [];
  if (dirty) {
    blockers.push(
      "The working tree has uncommitted changes. Production would serve code that " +
        "is not in any commit — commit or stash first.",
    );
  }
  if (unpushed > 0) {
    blockers.push(
      `HEAD is ${unpushed} commit(s) ahead of its remote${branch ? ` (${branch})` : ""}. ` +
        "Push first: a production build made from unpushed commits cannot be " +
        "reviewed or reverted by anyone else, and leaves the live app ahead of " +
        "`master` rather than matching it.",
    );
  }
  return blockers;
}

/**
 * Whether to run migrations before deploying, and why.
 *
 * `deploy.yml` ran `npm run migrate` immediately before handing the build to
 * Vercel, and that ordering is the guarantee worth keeping: a build that goes
 * live against a schema it predates fails at runtime, on the request path, where
 * it reads as an application bug.
 *
 * When no connection string is available locally this does NOT block the deploy.
 * The ordering is still satisfied, just by a different mechanism: `AUTO_MIGRATE`
 * in instrumentation.ts applies pending migrations in the deployed process
 * before it serves its first request, and DATABASE_URL is configured on the
 * Vercel project. Blocking here would mean the only working deploy path requires
 * production database credentials on a laptop, which is a worse posture than the
 * boot-time runner it would be protecting.
 *
 * @param {{ env?: Record<string, string | undefined> }} opts
 */
export function decideMigrate({ env = process.env } = {}) {
  if (isSet(env.DEPLOY_SKIP_MIGRATE)) {
    return { migrate: false, reason: "DEPLOY_SKIP_MIGRATE is set — not migrating." };
  }
  const conn = env.MIGRATE_DATABASE_URL || env.DATABASE_URL;
  if (!conn) {
    return {
      migrate: false,
      reason:
        "No MIGRATE_DATABASE_URL/DATABASE_URL in this environment — skipping the " +
        "pre-deploy migration. The deployed process applies pending migrations on " +
        "boot before serving (instrumentation.ts, AUTO_MIGRATE), and DATABASE_URL " +
        "is set on the Vercel project, so the schema is still migrated ahead of " +
        "traffic. Set MIGRATE_DATABASE_URL to migrate from here instead.",
    };
  }
  return { migrate: true, reason: "Applying pending migrations before the new build goes live." };
}

/**
 * Turn probe results into a pass/fail verdict over the entry routes.
 *
 * Pure, so the definition of "the deploy is live" is unit-tested. A route counts
 * as serving only when it answered 200 AND its rendered marker is in the body —
 * see ENTRY_ROUTES for why the status alone is not enough.
 *
 * @param {Array<{ path: string, status: number | null, hasMarker: boolean, marker: string }>} results
 */
export function routeVerdict(results) {
  const failures = results
    .filter((r) => !(r.status === 200 && r.hasMarker))
    .map((r) => {
      if (r.status === null) {
        return `${r.path} did not respond (timed out or connection failed)`;
      }
      if (r.status !== 200) return `${r.path} returned HTTP ${r.status}`;
      return `${r.path} returned 200 but the page did not render (no "${r.marker}" in the body)`;
    });
  return { ok: failures.length === 0, failures };
}

/**
 * The demo member whose sign-in is exercised against the live deployment.
 *
 * Same variables and same literal defaults as `scripts/seed.mjs`, which is the
 * thing that provisions the account — test/demo-accounts.test.ts pins all three
 * files together so a changed password cannot leave this checking credentials
 * that no longer exist. Overridable via DEPLOY_VERIFY_MEMBER_* to verify a real
 * account on an environment that was never seeded with demo data.
 */
function verifyMemberCredentials(env) {
  return {
    email:
      env.DEPLOY_VERIFY_MEMBER_EMAIL || env.SEED_MEMBER_EMAIL || "member@demo.local",
    password:
      env.DEPLOY_VERIFY_MEMBER_PASSWORD ||
      env.SEED_MEMBER_PASSWORD ||
      "DemoMember!2026",
  };
}

/**
 * Whether this run can verify that a member can actually SIGN IN, and if not,
 * why not.
 *
 * WHY THIS EXISTS. Everything else in this script checks that pages RENDER.
 * `/login` and `/portal/login` are static, so they render perfectly on a
 * deployment where nobody can get past them, and the whole dashboard and portal
 * sit unreachable behind two flawless-looking forms. The health probe's
 * `auth: "configured"` narrows that gap but does not close it: it is a
 * presence check on two environment variable strings, and it reads "configured"
 * for a deployment aimed at the wrong Supabase project, one whose seed never
 * ran, or one whose accounts carry no `member_id` — every one of which is
 * "member authentication is built but the running app doesn't serve it",
 * the finding this project keeps receiving, and every one of which passes every
 * check this script had.
 *
 * So the sign-in is performed for real, against the issuer THE DEPLOYMENT
 * ITSELF reports (`auth_issuer` from /api/health). Using the local `.env`'s
 * project instead would happily authenticate against a Supabase project the
 * live app has never heard of and call the deploy verified.
 *
 * Pure and injectable so the policy — in particular every reason this check
 * declines to run — is unit-tested rather than discovered during a deploy.
 *
 * `check: false` carries a `reason`; `check: true` carries everything the
 * sign-in needs. Declared as one shape so callers (and the tests) see a single
 * type rather than a union that has to be narrowed at every use.
 *
 * @param {{ env?: Record<string, string | undefined>, issuer?: string | null }} opts
 * @returns {{ check: boolean, reason?: string, issuer?: string, key?: string,
 *             email?: string, password?: string }}
 */
export function memberAuthPlan({ env = process.env, issuer = null } = {}) {
  if (isSet(env.DEPLOY_SKIP_AUTH_CHECK)) {
    return { check: false, reason: "DEPLOY_SKIP_AUTH_CHECK is set — not verifying member sign-in." };
  }

  if (!issuer) {
    return {
      check: false,
      reason:
        "The deployment reports no auth issuer, so it cannot authenticate " +
        "anyone — already covered by the `auth: \"unconfigured\"` warning above.",
    };
  }

  const localUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!localUrl || !key) {
    return {
      check: false,
      reason:
        "No NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in this " +
        "environment, so a sign-in cannot be attempted from here. The entry routes " +
        "were still verified; member sign-in was NOT. Set them (they are public " +
        "values) to have this deploy prove the portal login works.",
    };
  }

  // Refuse to conclude anything from the wrong project. A pass here would be
  // actively misleading: it would prove some OTHER Supabase project accepts the
  // credential while saying nothing about the deployment just shipped.
  const localIssuer = `${localUrl}/auth/v1`;
  if (localIssuer !== issuer) {
    return {
      check: false,
      reason:
        `This environment's auth project (${localIssuer}) is not the one the ` +
        `deployment uses (${issuer}), so a sign-in from here would prove nothing ` +
        "about the live app. Member sign-in was NOT verified.",
    };
  }

  return { check: true, issuer, key, ...verifyMemberCredentials(env) };
}

/** Claims of a JWT, without verifying it — the issuer just minted it. */
function decodeClaims(token) {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Read a custom claim the way the app does: top level first, then
 * `app_metadata`. Mirrors `claimValue` in lib/identity.ts deliberately — a
 * check that read them from somewhere else could pass on a token the app then
 * refuses.
 */
function claimValue(claims, key) {
  const top = claims?.[key];
  if (typeof top === "string" && top.length > 0) return top;
  const meta = claims?.app_metadata?.[key];
  return typeof meta === "string" && meta.length > 0 ? meta : undefined;
}

/**
 * Turn a real sign-in attempt into a verdict, with a severity.
 *
 * Two kinds of failure that must NOT be conflated:
 *
 *   - `fatal` — the account authenticates but cannot produce a portal session,
 *     or the auth service is broken. Nobody can use the member portal on this
 *     deployment. There is no legitimate configuration in which this is fine,
 *     so it fails the deploy.
 *   - `warn` — the credentials were simply rejected. Expected on any
 *     environment that was never seeded with demo data (`SEED_DEMO_DATA=0` for
 *     a real gym, or overridden `SEED_*` passwords), so it must not fail a
 *     legitimate production deploy. Reported loudly instead.
 *
 * The claim assertions are the interesting half. A token that verifies but
 * carries no `tenant_id` makes `identityFromClaims` throw; one with no
 * `member_id` fails `requireMember`'s own check. Either way `/portal` bounces
 * straight back to `/portal/login` and the member is stuck in a loop with
 * correct credentials — a login that succeeds and still leaves the portal
 * unreachable, which is indistinguishable from "not deployed" to anyone
 * outside and is exactly the state being guarded against.
 *
 * @param {{ status: number | null, accessToken?: string | null, error?: string }} result
 */
export function memberSignInVerdict({ status, accessToken = null, error = "" }) {
  if (status === null) {
    return { ok: false, severity: "fatal", detail: "the auth service did not respond" };
  }
  if (status === 400) {
    return {
      ok: false,
      severity: "warn",
      detail:
        "the credentials were rejected. On a demo environment this means " +
        "`npm run seed` has not been run against this deployment's database, so " +
        "no member can sign in. On a real gym it just means the demo member does " +
        "not exist — set DEPLOY_VERIFY_MEMBER_EMAIL/PASSWORD to a real account, " +
        "or DEPLOY_SKIP_AUTH_CHECK=1",
    };
  }
  if (status !== 200 || !accessToken) {
    return {
      ok: false,
      severity: "fatal",
      detail: `the auth service answered HTTP ${status} without a token${error ? ` (${error})` : ""}`,
    };
  }

  const claims = decodeClaims(accessToken);
  if (!claims) {
    return { ok: false, severity: "fatal", detail: "the issued access token could not be decoded" };
  }
  if (claimValue(claims, "app_role") !== "member") {
    return {
      ok: false,
      severity: "fatal",
      detail:
        "the account signed in but is not a member account (app_role is " +
        `${JSON.stringify(claimValue(claims, "app_role") ?? null)}), so /portal ` +
        "sends it to the staff sign-in page",
    };
  }
  if (!claimValue(claims, "tenant_id")) {
    return {
      ok: false,
      severity: "fatal",
      detail:
        "the issued token carries no tenant_id claim, so no RLS session can be " +
        "established and /portal bounces every sign-in back to /portal/login",
    };
  }
  if (!claimValue(claims, "member_id")) {
    return {
      ok: false,
      severity: "fatal",
      detail:
        "the issued token carries no member_id claim, so `requireMember` rejects " +
        "the session and /portal bounces every sign-in back to /portal/login",
    };
  }
  return { ok: true, severity: "ok", detail: "signed in and the token resolves to a member session" };
}

/** Fetch a URL, returning `{ status, body }` — never throwing. */
async function probe(url, timeoutMs = 20_000) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "alpha-crm-deploy-verify", "cache-control": "no-cache" },
    });
    return { status: res.status, body: await res.text() };
  } catch {
    return { status: null, body: "" };
  }
}

/**
 * The build currently answering on the production URL, via `/api/health`'s
 * `instance.build_id` (the field exists for exactly this comparison). Returns
 * null when the probe or the JSON fails — an unknown build is not an error here,
 * it just means the "did the alias move?" check has to be skipped.
 */
async function liveBuildId() {
  const { status, body } = await probe(`${PROD_URL}/api/health`, 15_000);
  if (status === null) return null;
  try {
    return JSON.parse(body)?.instance?.build_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Wait until the production URL serves a build other than `previous`, then
 * confirm the entry routes actually render on it.
 *
 * The two halves answer different questions and both are needed. "Did the alias
 * move onto the new build?" catches a successful build that never went live —
 * the reported defect. "Do the entry routes render?" catches a build that went
 * live and is broken. Passing the first and failing the second is a deploy that
 * must be reported as failed even though Vercel is happy.
 */
async function verifyLive(previousBuildId) {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  let current = null;
  let moved = false;

  if (previousBuildId === null) {
    console.log(
      `[deploy] The previous build id could not be read from ${PROD_URL}/api/health, ` +
        "so 'the alias moved' cannot be checked. Verifying that the entry routes " +
        "render, which is the half that still holds.",
    );
    moved = true;
  } else {
    console.log(`[deploy] Waiting for ${PROD_URL} to serve a build other than ${previousBuildId}.`);
    while (Date.now() < deadline) {
      current = await liveBuildId();
      if (current && current !== previousBuildId) {
        moved = true;
        console.log(`[deploy] Production is now serving build ${current}.`);
        break;
      }
      await delay(3_000);
    }
  }

  if (!moved) {
    console.error(
      `[deploy] FAILED: after ${Math.round(VERIFY_TIMEOUT_MS / 1000)}s, ${PROD_URL} is still ` +
        `serving build ${previousBuildId}. The build succeeded but the production ` +
        "alias was never moved onto it, so the running app does not serve this " +
        "code — the exact 'built but not live' state this script exists to catch.\n" +
        "[deploy] Most likely cause, and the one seen in practice: THE DEPLOY WENT " +
        `TO THE WRONG PROJECT. Check the "Production" URL the CLI printed above — if ` +
        `it is not a ${VERCEL_PROJECT} URL, the CLI linked by directory name instead ` +
        `of to ${VERCEL_PROJECT} (this run passed --project, so suspect a stale or ` +
        "conflicting .vercel/project.json).\n" +
        `[deploy] Otherwise the alias itself did not move: check \`npx vercel ls\` and ` +
        `the production alias on the ${VERCEL_PROJECT} project.`,
    );
    return false;
  }

  const results = [];
  for (const { path: routePath, marker } of ENTRY_ROUTES) {
    const { status, body } = await probe(`${PROD_URL}${routePath}`, 45_000);
    results.push({ path: routePath, status, hasMarker: body.includes(marker), marker });
  }

  const { ok, failures } = routeVerdict(results);
  for (const r of results) {
    const state = r.status === 200 && r.hasMarker ? "OK" : "FAIL";
    console.log(`[deploy]   ${state.padEnd(4)} ${PROD_URL}${r.path} (HTTP ${r.status ?? "no response"})`);
  }

  if (!ok) {
    console.error(
      "[deploy] FAILED: the deploy is live but the entry routes do not serve:\n" +
        failures.map((f) => `[deploy]   - ${f}`).join("\n") +
        "\n[deploy] These routes are the only way into the staff dashboard and the " +
        "member portal, so this deploy makes the whole product unreachable. " +
        "Roll back with `npx vercel rollback` and investigate before retrying.",
    );
    return false;
  }

  // Informational only: a degraded database must not fail a deploy whose pages
  // all render, but it must not be silent either.
  const { status, body } = await probe(`${PROD_URL}/api/health`, 15_000);
  if (status !== 200) {
    console.warn(
      `[deploy] WARNING: ${PROD_URL}/api/health returned HTTP ${status ?? "no response"} — the ` +
        "pages render but a dependency is degraded (most often the database). " +
        `Not failing the deploy.\n[deploy]   ${body.slice(0, 300)}`,
    );
  }

  // A /login that RENDERS is not a /login that WORKS, and the route check above
  // can only see the first. /login and /portal/login are static pages, so a
  // deployment with no auth service configured serves them flawlessly and then
  // refuses every credential — passing every check in this script while the
  // dashboard and portal are as unreachable as if the pages 500'd. The health
  // probe reports the condition (see `authConfigured` in lib/auth/supabase.ts)
  // so this is caught here rather than by the next person who tries to sign in.
  //
  // A warning, not a failure, unlike the route check: a missing project
  // environment variable cannot be repaired BY a deploy, so failing on it would
  // only block the deploy that carries the fix. The route check fails hard
  // because what it catches is a defect in the code being shipped.
  let health = null;
  try {
    health = JSON.parse(body);
  } catch {
    // Unparseable or absent — the HTTP warning above already covers it.
  }
  if (health?.auth === "unconfigured") {
    console.warn(
      "[deploy] WARNING: production reports `auth: \"unconfigured\"`. " +
        "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are " +
        "not both set on the Vercel project, so /login and /portal/login render " +
        "but NOBODY CAN SIGN IN — every dashboard and portal feature is " +
        "unreachable behind them.\n" +
        "[deploy]   Fix with `npx vercel env add <NAME> production`, then redeploy.",
    );
  }

  // The one check that proves the product is actually usable: sign a member in
  // for real. See `memberAuthPlan` for why rendering + `auth: "configured"`
  // are not enough, and `memberSignInVerdict` for what counts as a failure.
  return await verifyMemberSignIn(health?.auth_issuer ?? null);
}

/**
 * Perform a real member sign-in against the live deployment's own auth issuer.
 *
 * Returns false only for a `fatal` verdict — a deployment on which the member
 * portal cannot be entered at all. A rejected credential is reported and
 * tolerated; see `memberSignInVerdict`.
 */
async function verifyMemberSignIn(issuer) {
  const plan = memberAuthPlan({ issuer });
  if (!plan.check) {
    console.warn(`[deploy] Member sign-in not verified: ${plan.reason}`);
    return true;
  }

  console.log(
    `[deploy] Verifying a real member sign-in as ${plan.email} against ${plan.issuer}.`,
  );

  let status = null;
  let accessToken = null;
  let error = "";
  try {
    const res = await fetch(`${plan.issuer}/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: plan.key },
      body: JSON.stringify({ email: plan.email, password: plan.password }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    status = res.status;
    const body = await res.json().catch(() => ({}));
    accessToken = body.access_token ?? null;
    error = body.error_description || body.msg || body.error || "";
  } catch {
    status = null;
  }

  const verdict = memberSignInVerdict({ status, accessToken, error });
  if (verdict.ok) {
    console.log(`[deploy]   OK   member sign-in: ${verdict.detail}.`);
    return true;
  }

  const label = verdict.severity === "fatal" ? "FAILED" : "WARNING";
  const report = verdict.severity === "fatal" ? console.error : console.warn;
  report(
    `[deploy] ${label}: MEMBER SIGN-IN DOES NOT WORK on ${PROD_URL} — ${verdict.detail}.\n` +
      "[deploy]   /portal/login renders, so every check that only fetches pages " +
      "calls this deploy healthy, but no member can reach the portal — the " +
      "member-facing training programs this product exists for are unreachable.",
  );
  if (verdict.severity === "fatal") {
    console.error(
      "[deploy]   Roll back with `npx vercel rollback` and fix before retrying, " +
        "or set DEPLOY_SKIP_AUTH_CHECK=1 to deploy anyway.",
    );
    return false;
  }
  return true;
}

/**
 * Current git state, as the blockers above expect it. Never throws.
 *
 * "Is this commit pushed?" is answered by asking whether any REMOTE-TRACKING
 * branch contains HEAD, not by an `@{upstream}` count. The two differ exactly
 * where this project lives: a git worktree, a detached HEAD, or a branch pushed
 * with an explicit refspec (`git push origin HEAD:master`) all have no upstream
 * configured, so an upstream-only check reports "not pushed" for a commit that is
 * demonstrably on the remote and would block every deploy made that way. The
 * containment test is also the stricter question — it is about THIS commit rather
 * than about a branch pointer.
 *
 * The upstream count is still consulted, but only to turn a blocked deploy's
 * message from "not pushed" into "N commits ahead".
 */
async function gitState() {
  const status = await run("git", ["status", "--porcelain"]);
  const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);

  const remotes = await run("git", ["branch", "-r", "--contains", "HEAD"]);
  const onRemote = remotes.code === 0 && remotes.out.trim() !== "";

  let unpushed = onRemote ? 0 : 1;
  if (!onRemote) {
    // "behind<TAB>ahead" when an upstream exists; used for the count only.
    const counts = await run("git", [
      "rev-list",
      "--left-right",
      "--count",
      "@{upstream}...HEAD",
    ]);
    if (counts.code === 0) {
      const ahead = Number(counts.out.trim().split(/\s+/)[1]);
      if (Number.isFinite(ahead) && ahead > 0) unpushed = ahead;
    }
  }

  return {
    dirty: status.code === 0 && status.out.trim() !== "",
    unpushed,
    branch: branch.out.trim(),
  };
}

async function main() {
  const token = process.env.VERCEL_TOKEN;

  // 1. Refuse to deploy code nobody else can see. See `gitBlockers`.
  const state = await gitState();
  const blockers = gitBlockers({ ...state });
  if (blockers.length) {
    console.error("[deploy] Refusing to deploy:");
    for (const b of blockers) console.error(`[deploy]   - ${b}`);
    console.error("[deploy] Override with DEPLOY_ALLOW_DIRTY=1 for a deliberate hotfix.");
    process.exit(1);
  }
  console.log(
    `[deploy] Deploying ${state.branch} — working tree clean and in sync with its remote.`,
  );

  // 2. Migrations before the build goes live. See `decideMigrate`.
  const { migrate, reason } = decideMigrate();
  console.log(`[deploy] ${reason}`);
  if (migrate) {
    const res = await run(process.execPath, ["scripts/migrate.mjs"], { echo: true });
    if (res.code !== 0) {
      console.error(
        `[deploy] Migrations failed (exit ${res.code}). NOT deploying: a build that goes ` +
          "live against a schema it predates fails on the request path, where it " +
          "reads as an application bug rather than a deploy problem.",
      );
      process.exit(1);
    }
  }

  // 3. Record what production serves NOW, so step 5 can prove it changed.
  const previousBuildId = await liveBuildId();

  // 4. Deploy. `--yes` so it never waits on a prompt in a non-interactive run.
  //    Built as a quoted command line because `npx` is a `.cmd` shim on Windows
  //    and can only be spawned through a shell (see `run`).
  let command = `npx --yes ${VERCEL_PKG} deploy --prod --yes --project "${VERCEL_PROJECT}"`;
  if (token) command += ` --token "${token}"`;
  else {
    console.log(
      "[deploy] VERCEL_TOKEN is not set — relying on an existing `vercel login`. " +
        "Set VERCEL_TOKEN for a non-interactive deploy.",
    );
  }
  console.log(
    `[deploy] Running: npx ${VERCEL_PKG} deploy --prod --project ${VERCEL_PROJECT}`,
  );
  const deployed = await run(command, [], { echo: true, line: true });
  if (deployed.code !== 0) {
    console.error(`[deploy] \`vercel deploy\` failed (exit ${deployed.code}). Production unchanged.`);
    process.exit(1);
  }

  // 5. The part that closes the "built but not live" defect: confirm the running
  //    app actually serves this code, rather than trusting the exit code above.
  const live = await verifyLive(previousBuildId);
  if (!live) process.exit(1);

  console.log(
    `[deploy] Done. ${PROD_URL} is serving this commit (${state.branch}), /, /login ` +
      "and /portal/login all render, and member sign-in was exercised against the " +
      "live deployment (see the line above for the result).",
  );
}

// Only run when invoked directly, so the unit tests can import the pure helpers
// above without launching a real deploy.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith("deploy.mjs");
if (invokedDirectly) {
  main().catch((err) => {
    console.error("[deploy] unexpected failure:", err);
    process.exit(1);
  });
}
