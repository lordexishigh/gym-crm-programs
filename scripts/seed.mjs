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
import { pathToFileURL } from "node:url";
import pg from "pg";

/**
 * Built-in exercise catalog (alpha-exercise-library-003).
 *
 * Canonical, ready-to-use exercises with teaching content (instructions,
 * guidelines, tips). They are seeded into EVERY gym's own exercise_library so
 * the catalog is "already inside the CRM" and isolated per tenant (no shared/
 * global table — keeps RLS isolation-by-construction intact). Each entry ships
 * with a demonstration `image_url` from the open-source, public-domain
 * free-exercise-db (https://github.com/yuhonas/free-exercise-db); a gym can
 * paste its own URL per exercise to override it, and the library UI renders a
 * branded placeholder for any exercise with no image URL set. Exported so a
 * future gym-provisioning flow can reuse it.
 */
const IMG_BASE =
  "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/";

export const EXERCISE_CATALOG = [
  {
    name: "Back Squat",
    category: "Legs",
    image_url: `${IMG_BASE}Barbell_Squat/0.jpg`,
    sets: 5,
    reps: "5",
    rest: "120s",
    instructions:
      "Set the bar across your upper back (not the neck) and unrack.\nBrace your core, take a shoulder-width stance, toes slightly out.\nSit down and back, keeping the chest tall, until hips drop below the knees.\nDrive through mid-foot to stand back up to full lockout.",
    guidelines:
      "Keep the knees tracking over the toes and the spine neutral. Do not let the heels lift or the chest collapse forward. Use safety pins or a spotter for heavy sets.",
    tips: "Spread the floor with your feet and squeeze the bar to stay tight out of the bottom.",
  },
  {
    name: "Front Squat",
    category: "Legs",
    image_url: `${IMG_BASE}Front_Barbell_Squat/0.jpg`,
    sets: 4,
    reps: "6",
    rest: "120s",
    instructions:
      "Rack the bar on the front of the shoulders with elbows high.\nBrace and descend straight down, keeping the torso upright.\nReach full depth, then drive up while keeping the elbows high.",
    guidelines:
      "Elbows dropping is the most common fault and dumps the bar forward — keep them pointed ahead throughout. Keep the wrists relaxed; the shoulders carry the bar.",
    tips: "If wrist mobility is limited, use a cross-arm grip or lifting straps.",
  },
  {
    name: "Conventional Deadlift",
    category: "Posterior chain",
    image_url: `${IMG_BASE}Barbell_Deadlift/0.jpg`,
    sets: 3,
    reps: "5",
    rest: "180s",
    instructions:
      "Stand with mid-foot under the bar, shins close.\nHinge to grip just outside the knees, drop the hips, lift the chest.\nTake the slack out of the bar, then push the floor away.\nLock out by standing tall — do not lean back.",
    guidelines:
      "Keep the bar against the legs and the back flat the whole way. Avoid rounding the lower back or jerking the bar off the floor.",
    tips: "Think 'push the floor away' rather than 'pull the bar up' to engage the legs.",
  },
  {
    name: "Romanian Deadlift",
    category: "Posterior chain",
    image_url: `${IMG_BASE}Romanian_Deadlift/0.jpg`,
    sets: 3,
    reps: "8-10",
    rest: "90s",
    instructions:
      "Start standing with the bar at the hips, soft knees.\nPush the hips back and lower the bar along the thighs.\nStop when you feel a strong hamstring stretch, then drive the hips forward to stand.",
    guidelines:
      "This is a hip hinge, not a squat — the knees stay mostly fixed. Keep the bar close and the back flat; do not chase depth past your hamstring flexibility.",
    tips: "Keep the lats tight to stop the bar drifting away from your legs.",
  },
  {
    name: "Barbell Bench Press",
    category: "Push",
    image_url: `${IMG_BASE}Barbell_Bench_Press_-_Medium_Grip/0.jpg`,
    sets: 5,
    reps: "5",
    rest: "120s",
    instructions:
      "Lie back with eyes under the bar, feet planted, shoulder blades pinched.\nUnrack and hold the bar over the chest.\nLower under control to the mid-chest, then press up and slightly back to lockout.",
    guidelines:
      "Keep the wrists stacked over the elbows and the shoulder blades retracted. Always use a spotter or safety arms for heavy sets; never bounce the bar off the chest.",
    tips: "Drive your feet into the floor and keep your upper back tight for a stable press.",
  },
  {
    name: "Overhead Press",
    category: "Push",
    image_url: `${IMG_BASE}Standing_Military_Press/0.jpg`,
    sets: 4,
    reps: "6-8",
    rest: "90s",
    instructions:
      "Start with the bar at the front of the shoulders, grip just outside shoulders.\nBrace the core and glutes, press the bar straight overhead.\nMove the head slightly back to clear the chin, then through as the bar passes.\nLock out with the bar over the mid-foot.",
    guidelines:
      "Avoid over-arching the lower back — squeeze the glutes to keep a stable trunk. Keep the bar path vertical.",
    tips: "Shrug the shoulders up at the top to finish in a strong, stable position.",
  },
  {
    name: "Pull-up",
    category: "Pull",
    image_url: `${IMG_BASE}Pullups/0.jpg`,
    sets: 4,
    reps: "5-8",
    rest: "90s",
    instructions:
      "Hang from the bar with hands just wider than shoulders, arms straight.\nPull the elbows down and back until the chin clears the bar.\nLower under control to a full hang.",
    guidelines:
      "Avoid kipping or swinging if training for strength. Keep the shoulders engaged at the bottom rather than hanging fully passive.",
    tips: "Use a band or assisted machine to build volume if you can't yet do full reps.",
  },
  {
    name: "Bent-over Row",
    category: "Pull",
    image_url: `${IMG_BASE}Bent_Over_Barbell_Row/0.jpg`,
    sets: 4,
    reps: "8-10",
    rest: "90s",
    instructions:
      "Hinge at the hips to ~45°, back flat, bar hanging at arm's length.\nPull the bar to the lower ribs, leading with the elbows.\nSqueeze the back, then lower under control.",
    guidelines:
      "Keep the torso angle fixed — do not use the lower back to heave the weight up. Maintain a neutral spine throughout.",
    tips: "Pause briefly at the top of each rep to make the back do the work.",
  },
  {
    name: "Walking Lunge",
    category: "Legs",
    image_url: `${IMG_BASE}Barbell_Walking_Lunge/0.jpg`,
    sets: 3,
    reps: "10 each leg",
    rest: "60s",
    instructions:
      "Step forward into a lunge until both knees reach ~90°.\nDrive through the front heel to bring the back leg through.\nStep straight into the next lunge, alternating legs.",
    guidelines:
      "Keep the front knee tracking over the foot and the torso upright. Take a long enough step that the front shin stays roughly vertical.",
    tips: "Hold dumbbells at your sides to add load once bodyweight is easy.",
  },
  {
    name: "Plank",
    category: "Core",
    image_url: `${IMG_BASE}Plank/0.jpg`,
    sets: 3,
    reps: "30-60s hold",
    rest: "45s",
    instructions:
      "Set the forearms under the shoulders, legs extended behind.\nBrace the core and squeeze the glutes so the body forms a straight line.\nHold for time, breathing normally.",
    guidelines:
      "Do not let the hips sag or pike up. Keep the neck neutral by looking at the floor.",
    tips: "Pull your elbows toward your toes (without moving) to fire the core harder.",
  },
  {
    name: "Hanging Leg Raise",
    category: "Core",
    image_url: `${IMG_BASE}Hanging_Leg_Raise/0.jpg`,
    sets: 3,
    reps: "8-12",
    rest: "60s",
    instructions:
      "Hang from a bar with a tight grip and engaged shoulders.\nRaise the legs by curling the pelvis up, not just lifting the thighs.\nLower under control without swinging.",
    guidelines:
      "Avoid using momentum — control beats height. Bend the knees to regress if straight legs are too hard.",
    tips: "Think about rolling the hips toward the ribs at the top for full ab engagement.",
  },
  {
    name: "Kettlebell Swing",
    category: "Conditioning",
    image_url: `${IMG_BASE}One-Arm_Kettlebell_Swings/0.jpg`,
    sets: 5,
    reps: "15-20",
    rest: "60s",
    instructions:
      "Stand with the bell a foot in front, hinge and grip the handle.\nHike it back between the legs, then snap the hips forward to float it to chest height.\nLet it fall and hinge again to absorb it.",
    guidelines:
      "Power comes from the hips, not the arms — the arms are just ropes. Keep the back flat and the bell close on the backswing.",
    tips: "Snap the glutes hard at the top; the bell should float weightless for a moment.",
  },
];

/**
 * Idempotently seed the built-in catalog into ONE gym's library.
 *
 * Each entry is UPSERTED keyed on the case-insensitive unique index
 * `(tenant_id, lower(name))` (migrations/0010): a new gym gets every built-in
 * inserted; re-running refreshes the built-in content in place instead of
 * duplicating. `is_seeded` is set true on BOTH the insert and the update branch
 * so a built-in is always flagged as such (user-created exercises keep the
 * column's `false` default — only this seed path sets it true).
 *
 * `client` is a PRIVILEGED pg client (this runs cross-tenant during boot /
 * provisioning, NOT inside an RLS `app_user` session), so it can write any
 * tenant's rows. Returns the number of rows affected.
 */
export async function seedExerciseCatalog(client, tenantId) {
  if (!tenantId) throw new Error("seedExerciseCatalog requires a tenantId.");
  let affected = 0;
  for (const ex of EXERCISE_CATALOG) {
    const res = await client.query(
      `insert into exercise_library
         (tenant_id, name, sets, reps, rest, category, image_url,
          instructions, guidelines, tips, is_seeded)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
       on conflict (tenant_id, lower(name)) do update set
         sets         = excluded.sets,
         reps         = excluded.reps,
         rest         = excluded.rest,
         category     = excluded.category,
         image_url    = excluded.image_url,
         instructions = excluded.instructions,
         guidelines   = excluded.guidelines,
         tips         = excluded.tips,
         is_seeded    = true`,
      [
        tenantId,
        ex.name,
        ex.sets ?? null,
        ex.reps ?? null,
        ex.rest ?? null,
        ex.category ?? null,
        ex.image_url ?? null,
        ex.instructions ?? null,
        ex.guidelines ?? null,
        ex.tips ?? null,
      ],
    );
    affected += res.rowCount ?? 0;
  }
  return affected;
}

/**
 * Seed the built-in catalog into EVERY gym's library. Used by `npm run seed`
 * and by the boot-time backfill (scripts/seed-catalog.mjs) so a brand-new gym
 * is never empty. Idempotent (see seedExerciseCatalog). Returns the gym count.
 */
export async function seedAllGyms(client) {
  const { rows: gyms } = await client.query("select id from gym");
  let affected = 0;
  for (const { id } of gyms) {
    affected += await seedExerciseCatalog(client, id);
  }
  console.log(
    `+ exercise catalog: ${affected} row(s) upserted across ${gyms.length} gym(s).`,
  );
  return gyms.length;
}

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

    // 4. Seed the built-in exercise catalog into every gym's library.
    await seedAllGyms(client);

    console.log("\n✓ Seed complete. Log in at /login with:");
    console.log(`    email:    ${EMAIL}`);
    console.log(`    password: ${PASSWORD}`);
  } finally {
    await client.end();
  }
}

// Run the owner/gym bootstrap only when invoked directly (`npm run seed`), so
// that EXERCISE_CATALOG / seedExerciseCatalog / seedAllGyms can be imported by
// scripts/seed-catalog.mjs (the boot-time backfill) WITHOUT triggering the
// Supabase auth-user bootstrap.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("Seed failed:", err.message || err);
    process.exit(1);
  });
}
