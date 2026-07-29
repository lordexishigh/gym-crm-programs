import { spawn } from "node:child_process";
import { createServer, connect, type Server, type Socket } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  openGate,
  resolveHost,
  resolvePort,
} from "../scripts/lib/dev-server.mjs";

/**
 * Regression guard for the dev server's READINESS GATE
 * (scripts/lib/dev-server.mjs), used by `npm run dev` and by `npm start` when a
 * checkout has no production build.
 *
 * THE DEFECT IT PINS. `next dev` binds its port long before it can serve
 * anything. Measured on this project from a cold `.next`:
 *
 *     port accepts connections   3.3s
 *     "✓ Ready in 5.1s"          5.1s
 *     GET / returns 200         19.3s
 *
 * For ~14s the app accepts connections and answers none of them, because dev
 * compiles each route on its FIRST REQUEST (`/` alone costs ~10s). Every
 * conventional readiness check — "is the port open?", "did it print Ready?" —
 * passes at 3-5s, so a caller starts navigating inside that window and its first
 * navigation waits out the compile. Against a 20s budget that is a coin flip:
 * `goto('/')` lands at ~16-17s locally and not at all on a slower host. An
 * automated review reported exactly that ("journey FAILS at step 1 (goto '/'):
 * Timeout 20000ms exceeded") and read it as a hung server.
 *
 * THE FIX. `next dev` is bound to an internal loopback port and its entry routes
 * are compiled there, unobserved; only once `/` has genuinely answered does a
 * byte-for-byte TCP forwarder open the PUBLIC port. Verified end-to-end after
 * the change: the port opens at 19.9s instead of 3.3s, and the first `GET /`
 * through it takes 0.9s instead of 15.9s. "Open" now means "usable".
 *
 * The forwarder is the load-bearing new piece, so it is tested directly against
 * stub upstreams (fast, and no dependence on a real compile): it must be a pure
 * byte pipe, or Server Actions, streaming RSC payloads and the HMR websocket
 * would break in dev.
 */

const ROOT = process.cwd();
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** Ask the OS for a currently-free port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

function closeServer(server: Server | HttpServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** An upstream that echoes back what it was told, so integrity is checkable. */
async function stubUpstream(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<number> {
  const port = await freePort();
  const server = createHttpServer(handler);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  cleanups.push(() => closeServer(server));
  return port;
}

describe("dev readiness gate — the TCP forwarder", () => {
  it("forwards a request and its response body verbatim", async () => {
    const upstreamPort = await stubUpstream((req, res) => {
      res.writeHead(201, { "content-type": "text/plain", "x-upstream": "yes" });
      res.end(`saw ${req.method} ${req.url}`);
    });
    const port = await freePort();

    const gate = await openGate({ port, host: "127.0.0.1", upstreamPort });
    cleanups.push(() => closeServer(gate));

    const res = await fetch(`http://127.0.0.1:${port}/portal/login?a=1`);
    expect(res.status).toBe(201);
    // Headers must arrive unmodified — the forwarder does not parse HTTP at all.
    expect(res.headers.get("x-upstream")).toBe("yes");
    expect(await res.text()).toBe("saw GET /portal/login?a=1");
  });

  it("forwards a POST body intact, so Server Actions still work", async () => {
    const upstreamPort = await stubUpstream((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c.toString()));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ bytes: body.length, body }));
      });
    });
    const port = await freePort();

    const gate = await openGate({ port, host: "127.0.0.1", upstreamPort });
    cleanups.push(() => closeServer(gate));

    // Large enough to span multiple TCP segments: a forwarder that buffered or
    // truncated would corrupt exactly this.
    const payload = "x".repeat(200_000);
    const res = await fetch(`http://127.0.0.1:${port}/login`, {
      method: "POST",
      body: payload,
    });
    const json = (await res.json()) as { bytes: number; body: string };
    expect(json.bytes).toBe(payload.length);
    expect(json.body).toBe(payload);
  });

  it("passes a protocol upgrade through, so dev HMR keeps working", async () => {
    // A websocket upgrade is the case an HTTP-parsing proxy gets wrong; the
    // forwarder is a raw pipe, so the 101 and the post-upgrade bytes both flow.
    const port = await freePort();
    const upstreamPort = await freePort();

    const upstream = createServer((sock) => {
      sock.once("data", (chunk) => {
        expect(chunk.toString()).toMatch(/Upgrade: websocket/);
        sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n");
        // Post-upgrade the framing is opaque bytes; echo them back.
        sock.on("data", (d) => sock.write(d));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
    cleanups.push(() => closeServer(upstream));

    const gate = await openGate({ port, host: "127.0.0.1", upstreamPort });
    cleanups.push(() => closeServer(gate));

    const received = await new Promise<string>((resolve, reject) => {
      let seen = "";
      const client: Socket = connect({ port, host: "127.0.0.1" }, () => {
        client.write(
          "GET /_next/webpack-hmr HTTP/1.1\r\nHost: localhost\r\n" +
            "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
      });
      client.on("data", (d) => {
        seen += d.toString();
        if (seen.includes("101") && !seen.includes("PING")) client.write("PING");
        if (seen.includes("PING")) {
          client.destroy();
          resolve(seen);
        }
      });
      client.on("error", reject);
      setTimeout(() => (client.destroy(), reject(new Error("upgrade timed out"))), 8_000);
    });

    expect(received).toMatch(/101 Switching Protocols/);
    expect(received).toMatch(/PING/);
  });

  it("survives an upstream that drops mid-connection instead of crashing", async () => {
    // A dev server restarting (or a route that kills the connection) must not
    // take the forwarder — and therefore the port — down with it.
    const port = await freePort();
    const upstreamPort = await freePort();
    const upstream = createServer((sock) => sock.destroy());
    await new Promise<void>((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
    cleanups.push(() => closeServer(upstream));

    const gate = await openGate({ port, host: "127.0.0.1", upstreamPort });
    cleanups.push(() => closeServer(gate));

    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    // Still listening: the next request gets a connection, not a dead port.
    expect(gate.listening).toBe(true);
  });
});

describe("dev readiness gate — port and host resolution", () => {
  it("prefers an explicit flag over PORT, and PORT over the default", () => {
    expect(resolvePort(["-p", "4123"])).toBe(4123);
    expect(resolvePort(["--port=4124"])).toBe(4124);
    expect(resolvePort(["--port", "4125"])).toBe(4125);

    const saved = process.env.PORT;
    try {
      process.env.PORT = "4200";
      // The flag still wins: the preflight check and the server must agree on
      // one port, or the check probes a port nothing will bind.
      expect(resolvePort(["-p", "4123"])).toBe(4123);
      expect(resolvePort([])).toBe(4200);
      delete process.env.PORT;
      expect(resolvePort([])).toBe(3000);
    } finally {
      if (saved === undefined) delete process.env.PORT;
      else process.env.PORT = saved;
    }
  });

  it("resolves the hostname the way `next` does", () => {
    expect(resolveHost(["-H", "127.0.0.1"])).toBe("127.0.0.1");
    expect(resolveHost(["--hostname=::1"])).toBe("::1");
    // A flag-looking value is not a hostname.
    expect(resolveHost(["-H", "-p"])).toBe(process.env.HOSTNAME || "0.0.0.0");
  });
});

describe("scripts/dev.mjs", () => {
  /** Run the dev entry point in a throwaway project dir. */
  function runDev(
    cwd: string,
    args: string[],
    env: Record<string, string> = {},
  ): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, "scripts", "dev.mjs"), ...args], {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"] as const,
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (out += d.toString()));
      const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, out });
      });
    });
  }

  function makeProjectDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "alpha-dev-"));
    cleanups.push(async () => {
      // A just-killed `next` child can still hold a handle here for a moment
      // (EPERM on Windows); a leftover temp dir is not worth failing a test over.
      for (let i = 0; i < 5; i += 1) {
        try {
          rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    });
    // `next` resolves from the wrapper's own location, so a package.json is all
    // this needs. Deliberately no `app/` dir: `next dev` then fails at startup.
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t" }));
    return dir;
  }

  it("refuses to start onto a port another process already holds", async () => {
    const dir = makeProjectDir();
    const port = await freePort();
    // Stand in for an orphaned dev server left behind by an earlier run.
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(port, resolve));
    cleanups.push(() => closeServer(squatter));

    const { code, out } = await runDev(dir, ["-p", String(port)]);

    expect(code).toBe(1);
    expect(out).toMatch(new RegExp(`Port ${port} is already in use`));
    // The danger is silently probing someone else's server — say so.
    expect(out).toMatch(/may be serving different code/);
  }, 45_000);

  it("never opens the public port when the dev server cannot serve", async () => {
    // The gate's whole contract: an open port must mean a served request. A dev
    // server that dies at startup must therefore leave the port SHUT, rather
    // than accept connections it can never answer.
    const dir = makeProjectDir();
    const port = await freePort();

    const run = runDev(dir, ["-p", String(port)]);
    // Sample while it is trying (and retrying) — the port must never open.
    for (let i = 0; i < 12; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const reachable = await new Promise<boolean>((resolve) => {
        const probe = connect({ port, host: "127.0.0.1" });
        probe.once("connect", () => (probe.destroy(), resolve(true)));
        probe.once("error", () => (probe.destroy(), resolve(false)));
        setTimeout(() => (probe.destroy(), resolve(false)), 400);
      });
      expect(reachable).toBe(false);
    }

    const { out } = await run;
    // It must have tried Turbopack and then retried on webpack, rather than
    // silently leaving nothing serving.
    expect(out).toMatch(/Retrying without Turbopack/);
    expect(out.match(/Couldn't find any `pages` or `app` directory/g)?.length).toBe(2);
  }, 60_000);

  it("opens the port anyway once the gate budget expires, so it is never worse than a direct bind", async () => {
    // The gate is bounded on purpose. If `/` cannot be confirmed, withholding
    // the port forever would hide a real failure behind an unreachable host —
    // strictly worse than `next dev`'s own behaviour. Past that budget it opens
    // and says so, letting the app's own response (even an error page) be seen.
    const dir = makeProjectDir();
    const port = await freePort();

    // The budget must expire well inside the wrapper's own lifetime, or the run
    // ends first and the timeout path is never reached. `next dev` fails here
    // after ~2s and is then retried on webpack, so ~5s of life against a 1s
    // budget leaves no race.
    const { out } = await runDev(dir, ["-p", String(port)], {
      DEV_GATE_MAX_MS: "1000",
    });

    expect(out).toMatch(/did not answer within 1s/);
    expect(out).toMatch(/opening the port anyway/);
  }, 45_000);
});
