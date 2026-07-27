import { createServer, type Server } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Regression guard for `npm start` (scripts/start.mjs).
 *
 * Both cases below used to present to a browser as "the whole product is
 * unreachable": `next start` exits, nothing ever binds the port, and a client
 * reaching the host through a forwarded port/container/proxy gets no TCP reset —
 * the SYN is black-holed and the navigation hangs until its own budget expires.
 * Every route "times out", including fully static ones like `/` and `/login`,
 * which reads as a hung server rather than a missing one.
 *
 * The wrapper must instead fail fast, non-zero, and say which of the two it is.
 * These tests run the real script (no mocks) so the contract is pinned end to
 * end.
 *
 * `next build` is never invoked, and that is itself part of the contract: a
 * missing build is REPORTED, not silently built, because `next build` deletes
 * `.next` before writing and would clobber any build/smoke/e2e run already using
 * it. Building is opt-in (START_AUTOBUILD=1), so `runStart` unsets that variable
 * unless a test asks for it.
 */

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "start.mjs");

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** A throwaway project dir with node_modules linked so `next` resolves. */
function makeProjectDir(withBuild: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), "alpha-start-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  // The wrapper resolves `next/dist/bin/next` from its own location, so only a
  // package.json is strictly needed here; the build marker is what varies.
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t" }));
  if (withBuild) {
    mkdirSync(path.join(dir, ".next"), { recursive: true });
    writeFileSync(path.join(dir, ".next", "BUILD_ID"), "test-build-id\n");
  }
  return dir;
}

type Run = { code: number | null; out: string };

function runStart(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<Run> {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  // Exercise the DEFAULT as genuinely unset, not as whatever the ambient
  // environment happens to carry — otherwise a machine with START_AUTOBUILD=1
  // exported would run real `next build`s from the test suite.
  if (!("START_AUTOBUILD" in env)) delete childEnv.START_AUTOBUILD;

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
    // Safety net: the wrapper must exit on its own in both scenarios.
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

describe("scripts/start.mjs", () => {
  it("fails fast and explains when there is no production build", async () => {
    const dir = makeProjectDir(false);
    const port = await freePort();

    const { code, out } = await runStart(dir, ["-p", String(port)]);

    expect(code).toBe(1);
    expect(out).toMatch(/No production build found/);
    expect(out).toMatch(/BUILD_ID/);
    // It must name the remedy, not just the symptom.
    expect(out).toMatch(/npm run build/);
    // And it must REPORT the missing build rather than build one behind the
    // operator's back: an implicit `next build` wipes `.next` first, so it
    // destroys the output of any build/smoke/e2e run sharing that directory —
    // which then fails somewhere unrelated (a prerender whose
    // `.next/server/pages-manifest.json` disappeared mid-build).
    expect(existsSync(path.join(dir, ".next", "BUILD_ID"))).toBe(false);
  }, 30_000);

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

  it("detects a .next directory that has no BUILD_ID as 'no build'", async () => {
    const dir = makeProjectDir(false);
    // An interrupted build, or a `.next` left by `next dev`: directory present,
    // BUILD_ID absent. `next start` rejects this, so the wrapper must catch it.
    mkdirSync(path.join(dir, ".next"), { recursive: true });
    const port = await freePort();

    const { code, out } = await runStart(dir, ["-p", String(port)]);

    expect(code).toBe(1);
    expect(out).toMatch(/No production build found/);
  }, 30_000);
});
