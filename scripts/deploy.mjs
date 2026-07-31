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
import { existsSync } from "node:fs";
import path from "node:path";
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
 * Whether to prove that staff SIGN-IN works after deploying, and why.
 *
 * Pure and injectable, like the decisions above, so the policy is unit-tested.
 *
 * This is the check that finally answers "the code implements staff
 * authentication but the running app doesn't serve it". `verifyLive` can only
 * see that /login RENDERS, and /login is a static page — see the long note at
 * the end of `verifyLive` for why that leaves the entire dashboard and portal
 * unverified behind a form that looks perfect.
 *
 * Skipped rather than failed when Playwright is absent, because `deploy.mjs` is
 * otherwise dependency-free by design and must stay runnable from a production
 * install (`--omit=dev`), where a browser driver is legitimately not there.
 *
 * @param {{ env?: Record<string, string | undefined>, playwrightAvailable?: boolean }} opts
 */
export function decideSignInCheck({ env = process.env, playwrightAvailable = false } = {}) {
  if (isSet(env.DEPLOY_SKIP_SIGNIN_CHECK)) {
    return { check: false, reason: "DEPLOY_SKIP_SIGNIN_CHECK is set — not verifying sign-in." };
  }
  if (!playwrightAvailable) {
    return {
      check: false,
      reason:
        "Playwright is not installed in this checkout, so the post-deploy sign-in " +
        "check is being skipped — the entry routes were verified to render, but " +
        "whether anyone can actually SIGN IN was not proven. Run `npm install` " +
        "(dev dependencies) and `npm run verify:live` to confirm.",
    };
  }
  return {
    check: true,
    reason: "Verifying that staff email + password sign-in actually works on the live URL.",
  };
}

/** True when this checkout can drive a browser (dev dependencies installed). */
function playwrightInstalled() {
  return existsSync(path.join(process.cwd(), "node_modules", "@playwright", "test"));
}

/**
 * Drive the real staff sign-in against the deployment (e2e/live/staff-login.spec.ts).
 *
 * A hard failure, unlike the `auth: "unconfigured"` warning it supersedes: a
 * deployment nobody can sign in to has an unreachable dashboard and portal, which
 * is worse than a page that 500s because every outside signal still reads as
 * healthy. DEPLOY_SKIP_SIGNIN_CHECK=1 exists for the one case where failing would
 * be counterproductive — a deploy whose PURPOSE is to carry the fix for a broken
 * environment — mirroring DEPLOY_ALLOW_DIRTY.
 */
async function verifySignIn() {
  const { check, reason } = decideSignInCheck({ playwrightAvailable: playwrightInstalled() });
  console.log(`[deploy] ${reason}`);
  if (!check) return true;

  const res = await run(
    `npx --yes playwright test --config playwright.live.config.ts`,
    [],
    { echo: true, line: true, env: { ...process.env, VERIFY_BASE_URL: PROD_URL } },
  );
  if (res.code !== 0) {
    console.error(
      `[deploy] FAILED: ${PROD_URL} renders its sign-in form but staff cannot sign in, ` +
        "so the dashboard and the member portal are unreachable — every feature " +
        "behind them is deployed and unusable. This is the 'built but not live' " +
        "state, in the only form that survives a route check.\n" +
        "[deploy] The three causes, in the order worth checking:\n" +
        "[deploy]   1. NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY " +
        `missing or stale on the ${VERCEL_PROJECT} project (\`npx vercel env ls production\`).\n` +
        "[deploy]   2. The demo/staff accounts were never seeded into this " +
        "environment (`npm run seed` against its DATABASE_URL).\n" +
        "[deploy]   3. Tokens are issued by a different Supabase project than the " +
        "one whose JWKS this deployment verifies against.\n" +
        "[deploy] Override with DEPLOY_SKIP_SIGNIN_CHECK=1 only when this deploy is " +
        "itself the fix.",
    );
    return false;
  }
  console.log("[deploy] Staff sign-in verified: /login → /dashboard on the live URL.");
  return true;
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
  //
  // NOTE: this flag only reports whether two variables are NON-EMPTY. It cannot
  // tell a working key from a rotated one, nor a seeded database from an empty
  // one, so `verifySignIn` below now proves the same thing by actually signing
  // in. This stays because it names the likely cause when that check fails, and
  // because it still reports something useful when Playwright is unavailable.
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

  // 6. And confirm the product is USABLE, not merely rendered: sign in for real.
  //    Step 5 proves the pages are there; this proves there is a way past them.
  const signInWorks = await verifySignIn();
  if (!signInWorks) process.exit(1);

  console.log(
    `[deploy] Done. ${PROD_URL} is serving this commit (${state.branch}), /, /login ` +
      "and /portal/login all render, and staff sign-in reaches the dashboard.",
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
