// Minimal Supabase Auth (GoTrue) stand-in for the end-to-end journey tests.
//
// The app's auth surface talks to GoTrue over plain fetch (lib/auth/supabase.ts,
// lib/auth/admin.ts) and verifies access tokens against the project's JWKS with
// ES256 (lib/identity.ts). This stub implements exactly that contract locally:
//
//   GET  /auth/v1/.well-known/jwks.json          → public ES256 key (JWKS)
//   POST /auth/v1/admin/users                    → create user (invite acceptance)
//   DELETE /auth/v1/admin/users/:id              → delete user (race cleanup)
//   POST /auth/v1/token?grant_type=password      → sign in, returns signed JWT
//   POST /auth/v1/token?grant_type=refresh_token → rotate session (middleware)
//   POST /auth/v1/logout                         → revoke (best-effort no-op)
//
// Tokens are REAL ES256 JWTs signed with a keypair generated at boot, with the
// issuer/audience the app enforces — so lib/identity.ts verifies them through
// the same code path used against production Supabase. Users live in memory;
// the process is throwaway (started/stopped by Playwright's webServer).
//
// The app must be built AND started with NEXT_PUBLIC_SUPABASE_URL pointing at
// this stub (http://127.0.0.1:54321) — Next.js inlines NEXT_PUBLIC_* values at
// build time, so a build made against another URL will not talk to it.

import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const PORT = Number(process.env.AUTH_STUB_PORT || 54321);
const BASE_URL = process.env.AUTH_STUB_URL || `http://127.0.0.1:${PORT}`;
const ISSUER = `${BASE_URL}/auth/v1`;
const KID = "e2e-stub-key-1";

/** @type {Map<string, {id: string, email: string, password: string, appMetadata: Record<string, unknown>}>} */
const usersByEmail = new Map();
/** @type {Map<string, string>} refresh token → user email */
const refreshTokens = new Map();

const { publicKey, privateKey } = await generateKeyPair("ES256", {
  extractable: true,
});
const publicJwk = {
  ...(await exportJWK(publicKey)),
  kid: KID,
  use: "sig",
  alg: "ES256",
};

async function issueTokens(user) {
  const accessToken = await new SignJWT({
    email: user.email,
    app_metadata: user.appMetadata,
    role: "authenticated",
  })
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);

  const refreshToken = randomBytes(24).toString("base64url");
  refreshTokens.set(refreshToken, user.email);
  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
    refresh_token: refreshToken,
    user: { id: user.id, email: user.email, app_metadata: user.appMetadata },
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", BASE_URL);
  const path = url.pathname;

  if (req.method === "GET" && path === "/auth/v1/.well-known/jwks.json") {
    return json(res, 200, { keys: [publicJwk] });
  }

  if (req.method === "POST" && path === "/auth/v1/admin/users") {
    const body = await readBody(req);
    const email = String(body.email ?? "").toLowerCase();
    if (!email || !body.password) {
      return json(res, 400, { msg: "email and password are required" });
    }
    if (usersByEmail.has(email)) {
      return json(res, 422, { msg: "A user with this email address has already been registered" });
    }
    const user = {
      id: randomUUID(),
      email,
      password: String(body.password),
      appMetadata: body.app_metadata ?? {},
    };
    usersByEmail.set(email, user);
    return json(res, 200, { id: user.id, email: user.email });
  }

  if (req.method === "DELETE" && path.startsWith("/auth/v1/admin/users/")) {
    const id = decodeURIComponent(path.slice("/auth/v1/admin/users/".length));
    for (const [email, user] of usersByEmail) {
      if (user.id === id) usersByEmail.delete(email);
    }
    return json(res, 200, {});
  }

  if (req.method === "POST" && path === "/auth/v1/token") {
    const grant = url.searchParams.get("grant_type");
    const body = await readBody(req);

    if (grant === "password") {
      const email = String(body.email ?? "").toLowerCase();
      const user = usersByEmail.get(email);
      if (!user || user.password !== String(body.password ?? "")) {
        return json(res, 400, {
          error: "invalid_grant",
          error_description: "Invalid login credentials",
        });
      }
      return json(res, 200, await issueTokens(user));
    }

    if (grant === "refresh_token") {
      const email = refreshTokens.get(String(body.refresh_token ?? ""));
      const user = email ? usersByEmail.get(email) : undefined;
      if (!user) {
        return json(res, 400, {
          error: "invalid_grant",
          error_description: "Invalid Refresh Token",
        });
      }
      refreshTokens.delete(String(body.refresh_token));
      return json(res, 200, await issueTokens(user));
    }

    return json(res, 400, { error: "unsupported_grant_type" });
  }

  if (req.method === "POST" && path === "/auth/v1/logout") {
    res.writeHead(204);
    return res.end();
  }

  return json(res, 404, { msg: `auth-stub: no route for ${req.method} ${path}` });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[auth-stub] GoTrue stand-in listening on ${BASE_URL} (issuer ${ISSUER})`);
});
