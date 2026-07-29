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
 * A MISSING BUILD IS THEREFORE BUILT, not merely reported. Reporting it — the
 * previous contract, which these tests used to pin — does nothing for the caller
 * that actually matters: a browser or probe pointed at that port waits out its
 * whole budget either way, because refusing to serve and hanging are the same
 * observable event. `.next/` is gitignored, so any harness that clones and runs
 * `npm start` hits this every time.
 *
 * What made building unsafe was concurrency, not building: `next build` DELETES
 * `.next` before writing, so two builds in one directory corrupt each other. A
 * lock now elects one builder while other starts wait for it, and the tests
 * below pin that protocol. They never run a real `next build`: each either opts
 * out (START_AUTOBUILD=0) or parks the wrapper behind a live lock, so the suite
 * stays fast and touches no real build.
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
  it("builds instead of refusing, so the port always ends up served", async () => {
    const dir = makeProjectDir(false);
    const port = await freePort();
    // Park the wrapper behind a live builder so the DEFAULT path is observable
    // without paying for a real `next build`. The vitest process is a
    // guaranteed-alive lock holder.
    plantLock(dir, JSON.stringify({ pid: process.pid }));

    const { out } = await runStart(dir, ["-p", String(port)]);

    // The old contract — refuse and tell the operator to build — must NOT be
    // what happens by default any more.
    expect(out).not.toMatch(/START_AUTOBUILD=0;/);
    expect(out).toMatch(/waiting for it to finish/);
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

/**
 * Spawn the wrapper and hand back the live child, for cases that must observe it
 * WHILE it is still running (`runStart` only resolves once it has exited).
 */
function startStart(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): { child: ReturnType<typeof spawn>; closed: Promise<Run> } {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  if (!("START_AUTOBUILD" in env)) delete childEnv.START_AUTOBUILD;

  const child = spawn(process.execPath, [SCRIPT, ...args], {
    cwd,
    env: childEnv as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"] as const,
  });
  cleanups.push(() => child.kill("SIGKILL"));

  let out = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (out += d.toString()));
  const closed = new Promise<Run>((resolve) => {
    child.on("close", (code) => resolve({ code, out }));
  });
  return { child, closed };
}

/** Poll `port` until it answers HTTP, or give up. */
async function fetchWhenUp(
  port: number,
  accept: string,
  budgetMs = 10_000,
): Promise<Response | null> {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    try {
      return await fetch(`http://127.0.0.1:${port}/`, { headers: { accept } });
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return null;
}

describe("scripts/start.mjs — the cold-start window", () => {
  /**
   * The regression that matters most, because it is the one that kept getting
   * reported as "the whole product is unreachable".
   *
   * Building a missing build fixed the end state but not the ~98s it takes to get
   * there (measured on a clean checkout of this repo). For that whole window the
   * port was still unbound, so requests were still black-holed and `/`, `/login`
   * and `/portal/login` still "timed out" — despite all three being prerendered
   * static pages with no server-side work capable of hanging. Nothing hung;
   * nothing listened.
   *
   * So the port must answer BEFORE the build finishes. A live lock stands in for
   * the slow build here, which keeps the test fast and runs no real `next build`.
   */
  it("answers on the port while the build is still pending", async () => {
    const dir = makeProjectDir(false);
    const port = await freePort();
    plantLock(dir, JSON.stringify({ pid: process.pid }));

    const { child, closed } = startStart(dir, ["-H", "127.0.0.1", "-p", String(port)], {
      // Long enough to observe the front door before the wait gives up.
      START_BUILD_WAIT_MS: "20000",
    });

    const res = await fetchWhenUp(port, "text/html");
    expect(res, "the port must be bound before the build completes").not.toBeNull();
    // 503 keeps readiness probes honest: a caller waiting for a non-5xx (the
    // Playwright webServer wait, a deploy gate) must keep waiting, not start
    // testing the placeholder.
    expect(res!.status).toBe(503);
    expect(res!.headers.get("retry-after")).toBeTruthy();
    expect(res!.headers.get("cache-control")).toBe("no-store");
    expect(res!.headers.get("content-type")).toMatch(/text\/html/);

    const body = await res!.text();
    // A real page, not a blank or unstyled one — and it recovers on its own.
    expect(body).toMatch(/Starting up/);
    expect(body).toMatch(/http-equiv="refresh"/);

    child.kill("SIGTERM");
    await closed;
  }, 40_000);

  it("gives a machine client JSON instead of the HTML placeholder", async () => {
    const dir = makeProjectDir(false);
    const port = await freePort();
    plantLock(dir, JSON.stringify({ pid: process.pid }));

    const { child, closed } = startStart(dir, ["-H", "127.0.0.1", "-p", String(port)], {
      START_BUILD_WAIT_MS: "20000",
    });

    const res = await fetchWhenUp(port, "application/json");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
    expect(res!.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res!.json()).toMatchObject({ status: "starting" });

    child.kill("SIGTERM");
    await closed;
  }, 40_000);

  it("releases the port when it gives up, leaving nothing orphaned on it", async () => {
    const dir = makeProjectDir(false);
    const port = await freePort();
    plantLock(dir, JSON.stringify({ pid: process.pid }));

    // Short wait: the builder never finishes, so the wrapper must exit AND stop
    // holding the port. A front door left behind would make the next start refuse
    // the port as "already in use" — trading a hang for a permanent conflict.
    const { code } = await runStart(dir, ["-H", "127.0.0.1", "-p", String(port)], {
      START_BUILD_WAIT_MS: "1500",
    });
    expect(code).toBe(1);

    // Bindable again means genuinely released.
    await expect(listenOn(port)).resolves.toBeTruthy();
  }, 40_000);

  it("does not put a proxy in front of a build that already exists", async () => {
    // The production/CI path: a build is present, so `next start` must bind the
    // public port itself exactly as it always did. No front door, no proxy hop.
    const dir = makeProjectDir(true);
    const port = await freePort();

    const { out } = await runStart(dir, ["-H", "127.0.0.1", "-p", String(port)]);

    expect(out).not.toMatch(/starting up/i);
  }, 40_000);
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
