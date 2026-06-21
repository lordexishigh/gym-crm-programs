// Bootstrap a first gym + owner (staff) account so the app can be logged into.
//
// The app is invite-only for members and has no public self-signup, so there is
// otherwise no way to create the FIRST staff account. This script does it:
//   1. upserts a demo `gym` row (the tenant),
//   2. creates a confirmed Supabase Auth user with app_metadata
//      { app_role: "staff", tenant_id: <gym id> } — the claims lib/identity.ts
//      reads to authorise a staff session,
//   3. upserts the matching `users` (staff, role=owner) row.
//
// Idempotent: re-running reuses the existing gym/auth user and resets the
// password to the configured value.
//
// Usage:
//   node scripts/seed.mjs                 # uses defaults below
//   SEED_ADMIN_EMAIL=me@x.com SEED_ADMIN_PASSWORD=secret123 node scripts/seed.mjs
//
// Requires (already in .env): DATABASE_URL (or MIGRATE_DATABASE_URL),
// NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY.
// NOTE: run migrations first (the `app_user` role grant, 0005) or login will
// still fail with "permission denied to set role app_user".

import "dotenv/config";
import pg from "pg";

const EMAIL = process.env.SEED_ADMIN_EMAIL || "owner@demo.local";
const PASSWORD = process.env.SEED_ADMIN_PASSWORD || "DemoOwner!2026";
const FULL_NAME = process.env.SEED_ADMIN_NAME || "Demo Owner";
const GYM_NAME = process.env.SEED_GYM_NAME || "Demo Gym";
const GYM_SLUG = process.env.SEED_GYM_SLUG || "demo-gym";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const DB_URL = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;

function requireEnv() {
  const missing = [];
  if (!DB_URL) missing.push("DATABASE_URL");
  if (!SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!SECRET_KEY) missing.push("SUPABASE_SECRET_KEY");
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(", ")} (see .env.example).`);
    process.exit(1);
  }
}

const adminHeaders = {
  "Content-Type": "application/json",
  apikey: SECRET_KEY,
  Authorization: `Bearer ${SECRET_KEY}`,
};

/** Find an existing auth user id by email (admin list, filtered). */
async function findAuthUserByEmail(email) {
  const res = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?per_page=200`,
    { headers: adminHeaders, cache: "no-store" },
  );
  if (!res.ok) return null;
  const body = await res.json().catch(() => ({}));
  const users = Array.isArray(body) ? body : body.users || [];
  const found = users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase());
  return found?.id ?? null;
}

/** Create (or update) a confirmed staff auth user; returns its id. */
async function upsertStaffAuthUser(tenantId) {
  const appMetadata = { app_role: "staff", tenant_id: tenantId };

  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      app_metadata: appMetadata,
    }),
    cache: "no-store",
  });
  const body = await createRes.json().catch(() => ({}));

  if (createRes.ok && body.id) {
    console.log(`+ created auth user ${EMAIL}`);
    return body.id;
  }

  // Already exists → look it up and refresh password + claims so the login works.
  const existingId = await findAuthUserByEmail(EMAIL);
  if (!existingId) {
    throw new Error(
      `Could not create or find auth user ${EMAIL}: ${body.msg || body.error || createRes.status}`,
    );
  }
  const updRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${existingId}`, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({
      password: PASSWORD,
      email_confirm: true,
      app_metadata: appMetadata,
    }),
    cache: "no-store",
  });
  if (!updRes.ok) {
    const e = await updRes.json().catch(() => ({}));
    throw new Error(`Found auth user but failed to update it: ${e.msg || e.error || updRes.status}`);
  }
  console.log(`= reused auth user ${EMAIL} (password + claims refreshed)`);
  return existingId;
}

async function main() {
  requireEnv();
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    // 1. Upsert the gym (tenant).
    const gym = await client.query(
      `insert into gym (name, slug) values ($1, $2)
         on conflict (slug) do update set name = excluded.name, updated_at = now()
         returning id`,
      [GYM_NAME, GYM_SLUG],
    );
    const tenantId = gym.rows[0].id;
    console.log(`+ gym "${GYM_NAME}" (${tenantId})`);

    // 2. Create/refresh the staff auth user with the tenant claim.
    const authUserId = await upsertStaffAuthUser(tenantId);

    // 3. Upsert the matching staff (owner) row.
    await client.query(
      `insert into users (tenant_id, email, full_name, role, auth_user_id)
         values ($1, $2, $3, 'owner', $4)
         on conflict (auth_user_id) do update
           set tenant_id = excluded.tenant_id,
               email     = excluded.email,
               full_name = excluded.full_name,
               role      = 'owner',
               updated_at = now()`,
      [tenantId, EMAIL, FULL_NAME, authUserId],
    );
    console.log(`+ staff owner row for ${EMAIL}`);

    console.log("\n✓ Seed complete. Log in at /login with:");
    console.log(`    email:    ${EMAIL}`);
    console.log(`    password: ${PASSWORD}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Seed failed:", err.message || err);
  process.exit(1);
});
