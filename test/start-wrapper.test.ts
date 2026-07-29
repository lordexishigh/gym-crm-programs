import { createServer, type Server } from "node:net";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Regression guard for `npm start` (scripts/start.mjs).
 *
 * Both failure modes below used to present to a browser as "the whole product is
 * unreachable": `next start` exits, nothing ever binds the port, and a client
 * reaching the host through a forwarded port/container/proxy gets no TCP reset —
 * the SYN is black-holed and the navigation hangs until its own budget expires.
 * Every route "times out", including fully static ones like `/` and `/login`,
 * which reads as a hung server rather than a missing one. One automated review
 * reported this four separate ways ("/ times out", "/login and /portal/login
 * time out (45s)", "both landing-page entry points are dead", "no fallback when
 * auth routes fail") — all the same missing build.
 *
 * A MISSING BUILD IS THEREFORE SERVED ANYWAY, not merely reported. Reporting it
 * does nothing for the caller that actually matters: a browser or probe pointed
 * at that port waits out its whole budget either way, because refusing to serve
 * and hanging are the same observable event. `.next/` is gitignored, so any
 * harness that clones and runs `npm start` hits this every time.
 *
 * Nor is BUILDING the repair, which is what these tests used to pin: `next build`
 * takes ~85s on this project and the port is unbound for every one of those
 * seconds, so the timeout the caller sees is unchanged. The fallback is `next dev`
 * — listening in ~8s, serving the real pages — announced loudly, and skipped
 * entirely whenever a production build exists.
 *
 * The one hazard shared by both is concurrency: `next build` DELETES `.next`
 * before writing, and the dev server writes there too, so two of them in one
 * directory corrupt each other. A lock elects one owner while other starts wait,
 * and the tests below pin that protocol. They never run a real build: each either
 * opts out (START_AUTOBUILD=0) or parks the wrapper behind a live lock, so the
 * suite stays fast and touches no real `.next`.
 *
 * Isolation: every case runs in a fresh temp dir. The wrapper derives its lock
 * path from a hash of the working directory, so these runs cannot disturb a real
 * build on the same machine, and no case can delete the repo's own `.next`.
 */

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "start.mjs");

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** Mirror of the wrapper's lock-path derivation (hash of the checkout path). */
function lockPathFor(cwd: string): string {
  const digest = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return path.join(tmpdir(), `alpha-crm-autobuild-${digest}.lock`);
}

/** A throwaway project dir; `next` still resolves from the wrapper's own path. */
function makeProjectDir(withBuild: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), "alpha-start-"));
  cleanups.push(() => {
    rmSync(lockPathFor(dir), { force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  // The wrapper resolves `next/dist/bin/next` from its own location, so only a
  // package.json is strictly needed here; the build marker is what varies.
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t" }));
  if (withBuild) {
    mkdirSync(path.join(dir, ".next"), { recursive: true });
    writeFileSync(path.join(dir, ".next", "BUILD_ID"), "test-build-id\n");
  }
  return dir;
}

/** Plant a lock owned by `pid`, as a concurrent builder would. */
function plantLock(dir: string, contents: string): string {
  const lock = lockPathFor(dir);
  writeFileSync(lock, contents);
  return lock;
}

/** A PID that is certainly not running: spawned, awaited, then its PID reused. */
function deadPid(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.on("close", () => resolve(child.pid as number));
  });
}

type Run = { code: number | null; out: string };

function runStart(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<Run> {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  // Exercise the DEFAULT as genuinely unset, not as whatever the ambient
  // environment happens to carry — otherwise a machine with START_AUTOBUILD
  // exported would not be testing the default at all.
  if (!("START_AUTOBUILD" in env)) delete childEnv.START_AUTOBUILD;
  // Keep every "wait for the other builder" case fast, regardless of ambient env.
  if (!("START_BUILD_WAIT_MS" in env)) childEnv.START_BUILD_WAIT_MS = "1500";

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd,
      env: childEnv as NodeJS.ProcessEnv,
      // `as const` keeps this a tuple: without it TS widens to string[] and the
      // spawn overloads collapse to `never`, hiding stdout/stderr.
      stdio: ["ignore", "pipe", "pipe"] as const,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    // Safety net: the wrapper must exit on its own in every scenario here.
    const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, () => {
      cleanups.push(() => server.close());
      resolve(server);
    });
  });
}

/** Ask the OS for a currently-free port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

describe("scripts/start.mjs — missing production build", () => {
  it("serves with `next dev` instead of refusing, so the port answers in seconds", async () => {
    const dir = makeProjectDir(false);
    const port = await freePort();

    const { out } = await runStart(dir, ["-p", String(port)]);

    // The default must be to serve, and to say so.
    expect(out).toMatch(/No production build found/);
    expect(out).toMatch(/serving with `next dev`/);
    // The old contract — refuse and tell the operator to build — must NOT be
    // what happens by default any more.
    expect(out).not.toMatch(/START_AUTOBUILD=0;/);
    // Dev mode is a stand-in, never silent about it.
    expect(out).toMatch(/DEVELOPMENT server/);
  }, 30_000);

  it("does not build first, because the port stays unbound for the whole build", async () => {
    const dir = makeProjectDir(false);
    const port = await freePort();

    const { out } = await runStart(dir, ["-p", String(port)]);

    // A build would take ~85s here; the reported symptom (every route times out)
    // is identical while it runs, so this path must not choose it.
    expect(out).not.toMatch(/running `next build` first/);
    // ...and must explain the trade-off it made instead.
    expect(out).toMatch(/UNBOUND/);
  }, 30_000);

  it("prefers Turbopack, and retries on webpack if it dies before serving", async () => {
    // The temp dir has no `app`/`pages`, so `next dev` exits within seconds —
    // which is exactly the "could not start" case the retry exists for. A
    // Turbopack that cannot run on some host would otherwise reproduce the very
    // failure this path prevents: nothing bound, every route timing out.
    const dir = makeProjectDir(false);
    const port = await freePort();

    const { out } = await runStart(dir, ["-p", String(port)]);

    expect(out).toMatch(/Turbopack/);
    expect(out).toMatch(/Retrying without Turbopack/);
    // Two attempts, so the failure is reported twice by `next` itself.
    expect(out.match(/Couldn't find any `pages` or `app` directory/g)?.length).toBe(2);
  }, 40_000);

  it("honours START_DEV_TURBOPACK=0 by not using Turbopack at all", async () => {
    const dir = makeProjectDir(false);
    const port = await freePort();

    const { out } = await runStart(dir, ["-p", String(port)], {
      START_DEV_TURBOPACK: "0",
    });

    expect(out).toMatch(/serving with `next dev`/);
    expect(out).not.toMatch(/Turbopack/);
  }, 40_000);

  it("waits for a live owner of .next rather than serving on top of it", async () => {
    const dir = makeProjectDir(false);
    const port = await freePort();
    // The vitest process is a guaranteed-alive lock holder, standing in for a
    // concurrent build; the dev fallback writes `.next` too, so it must wait.
    plantLock(dir, JSON.stringify({ pid: process.pid }));

    const { out } = await runStart(dir, ["-p", String(port)]);

    expect(out).toMatch(/waiting for it to finish/);
    expect(out).not.toMatch(/serving with `next dev`/);
  }, 30_000);

  it("fails fast and explains when autobuild is explicitly opted out", async () => {
    const dir = makeProjectDir(false);
    const port = await freePort();

    const { code, out } = await runStart(dir, ["-p", String(port)], {
      START_AUTOBUILD: "0",
    });

    expect(code).toBe(1);
    expect(out).toMatch(/No production build found/);
    expect(out).toMatch(/BUILD_ID/);
    // It must name the remedy, not just the symptom.
    expect(out).toMatch(/npm run build/);
    // Opting out must genuinely not build.
    expect(existsSync(path.join(dir, ".next", "BUILD_ID"))).toBe(false);
  }, 30_000);

  it("detects a .next directory that has no BUILD_ID as 'no build'", async () => {
    const dir = makeProjectDir(false);
    // An interrupted build, or a `.next` left by `next dev`: directory present,
    // BUILD_ID absent. `next start` rejects this, so the wrapper must catch it.
    mkdirSync(path.join(dir, ".next"), { recursive: true });
    const port = await freePort();

    const { code, out } = await runStart(dir, ["-p", String(port)], {
      START_AUTOBUILD: "0",
    });

    expect(code).toBe(1);
    expect(out).toMatch(/No production build found/);
  }, 30_000);
});

describe("scripts/start.mjs — concurrent-build lock", () => {
  it("waits for a live builder rather than starting a competing build", async () => {
    const dir = makeProjectDir(false);
    const port = await freePort();
    const lock = plantLock(dir, JSON.stringify({ pid: process.pid }));

    const { code, out } = await runStart(dir, ["-p", String(port)], {
      START_AUTOBUILD: "0",
    });

    expect(out).toMatch(new RegExp(`Another process \\(PID ${process.pid}\\) is building`));
    // Bounded: an unbounded wait would reintroduce the hang being fixed.
    expect(out).toMatch(/Timed out after/);
    expect(code).toBe(1);
    // A live holder's lock must be left strictly alone.
    expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid);
  }, 30_000);

  it("waits even when BUILD_ID exists, since a build in flight rewrites it", async () => {
    // The race this pins: `next build` writes BUILD_ID BEFORE the manifests
    // `next start` opens, so a start that trusts BUILD_ID while a build is live
    // launches and dies on a missing `.next/prerender-manifest.json`. Observed,
    // not theorised. Only the lock's release means "finished".
    const dir = makeProjectDir(true);
    const port = await freePort();
    plantLock(dir, JSON.stringify({ pid: process.pid }));

    const { code, out } = await runStart(dir, ["-p", String(port)], {
      START_AUTOBUILD: "0",
    });

    expect(out).toMatch(/is building/);
    expect(out).toMatch(/Timed out after/);
    expect(code).toBe(1);
  }, 30_000);

  it("reclaims a lock whose owner died, so a killed build cannot wedge later starts", async () => {
    const dir = makeProjectDir(false);
    const port = await freePort();
    const pid = await deadPid();
    plantLock(dir, JSON.stringify({ pid }));

    const { code, out } = await runStart(dir, ["-p", String(port)], {
      START_AUTOBUILD: "0",
    });

    expect(out).toMatch(new RegExp(`Reclaiming stale build lock from dead PID ${pid}`));
    // Having reclaimed it, it reaches the real decision instead of waiting out
    // a build that is never coming.
    expect(out).toMatch(/No production build found/);
    expect(out).not.toMatch(/Timed out after/);
    expect(code).toBe(1);
  }, 30_000);

  it("removes an unreadable lock instead of spinning on it forever", async () => {
    const dir = makeProjectDir(false);
    const port = await freePort();
    // A writer killed between creating and writing the lock leaves it empty:
    // unparseable, yet still blocking every atomic create that follows. Without
    // reclaiming it the wrapper would busy-spin (EEXIST vs unreadable) forever.
    plantLock(dir, "");

    const { code, out } = await runStart(dir, ["-p", String(port)], {
      START_AUTOBUILD: "0",
    });

    expect(out).toMatch(/Removing unreadable build lock/);
    expect(out).toMatch(/No production build found/);
    expect(code).toBe(1);
  }, 30_000);
});

describe("scripts/start.mjs — occupied port", () => {
  it("refuses to start onto a port another process already holds", async () => {
    const dir = makeProjectDir(true);
    const port = await freePort();
    // Stand in for an orphaned server left behind by an earlier run.
    await listenOn(port);

    const { code, out } = await runStart(dir, ["-p", String(port)]);

    expect(code).toBe(1);
    expect(out).toMatch(new RegExp(`Port ${port} is already in use`));
    // The danger is silently probing a server on an older build — say so.
    expect(out).toMatch(/older build/);
  }, 30_000);
});
