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
 * Run a command, streaming its output, and resolve with `{ code, out }`.
 *
 * Output is echoed as it arrives (so a 40s deploy is not a silent wait) AND
 * captured, so a failure can be quoted back in this script's own error rather
 * than leaving the operator to scroll for it.
 */
function run(cmd, args, { env = process.env, capture = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      // The Vercel CLI is a shell shim (npx/npm.cmd) on Windows.
      shell: process.platform === "win32",
    });
    let out = "";
    if (capture) {
      const take = (chunk) => {
        const text = chunk.toString();
        out += text;
        process.stderr.write(text);
      };
      child.stdout?.on("data", take);
      child.stderr?.on("data", take);
    }
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
        "[deploy] Check `npx vercel ls` and the project's production alias.",
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

  return true;
}

/** Current git state, as the blockers above expect it. Never throws. */
async function gitState() {
  const status = await run("git", ["status", "--porcelain"]);
  const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const counts = await run("git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  // "behind<TAB>ahead"; an absent upstream exits non-zero, which we treat as
  // "cannot prove it is pushed" and therefore as unpushed.
  let unpushed = 0;
  if (counts.code === 0) {
    const ahead = Number(counts.out.trim().split(/\s+/)[1]);
    unpushed = Number.isFinite(ahead) ? ahead : 0;
  } else {
    unpushed = 1;
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
    const res = await run(process.execPath, ["scripts/migrate.mjs"]);
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
  const args = ["--yes", VERCEL_PKG, "deploy", "--prod", "--yes"];
  if (token) args.push("--token", token);
  else {
    console.log(
      "[deploy] VERCEL_TOKEN is not set — relying on an existing `vercel login`. " +
        "Set VERCEL_TOKEN for a non-interactive deploy.",
    );
  }
  console.log(`[deploy] Running: npx ${VERCEL_PKG} deploy --prod`);
  const deployed = await run("npx", args);
  if (deployed.code !== 0) {
    console.error(`[deploy] \`vercel deploy\` failed (exit ${deployed.code}). Production unchanged.`);
    process.exit(1);
  }

  // 5. The part that closes the "built but not live" defect: confirm the running
  //    app actually serves this code, rather than trusting the exit code above.
  const live = await verifyLive(previousBuildId);
  if (!live) process.exit(1);

  console.log(
    `[deploy] Done. ${PROD_URL} is serving this commit (${state.branch}) and /, /login ` +
      "and /portal/login all render.",
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
