---
name: exercise-catalog-per-tenant
description: Why the built-in exercise catalog is seeded per-tenant into exercise_library, not a global shared table
metadata:
  type: project
---

The built-in/starter exercise catalog (images, instructions, guidelines, tips) is seeded **per tenant** into each gym's own `exercise_library` rows — there is **no global/shared catalog table**.

**Why:** The product's core promise is tenant isolation "by construction" via RLS (every tenanted table is RLS enabled+forced with `tenant_id = app_current_tenant()`). A globally-visible catalog table would require a cross-tenant SELECT policy — the first crack in that model. Per-tenant seeding keeps RLS untouched, lets ProgramBuilder/program pages/templates read the catalog with zero new plumbing (they already read `exercise_library`), and lets each gym edit/remove its own copies.

**How to apply:** Catalog data + the idempotent seeding helpers live in `scripts/seed.mjs` (`EXERCISE_CATALOG`, `seedExerciseCatalog(client, tenantId)`, `seedAllGyms(client)`). The per-entry write is an `ON CONFLICT (tenant_id, lower(name)) DO UPDATE` upsert, keyed on the case-insensitive unique index `uq_exercise_library_tenant_name` (`migrations/0010_exercise_library_seed_unique.sql`), so re-running refreshes built-in content in place without duplicating. `is_seeded` is set `true` on BOTH insert and update branches (it defaults `false`, so user-created exercises stay `false`; `createLibraryExerciseAction` must NOT set it). Rich columns added in `migrations/0009` (all nullable → backward compatible).

Seeding is WIRED (not manual-only): `instrumentation.ts` runs `scripts/seed-catalog.mjs` (→ `seedAllGyms`) on boot AFTER migrations, so every gym is backfilled by construction (opt-out `AUTO_SEED=0`). There is currently **no runtime gym-provisioning path** — gyms are created only by `npm run seed` (`scripts/seed.mjs`, which also seeds) — so the boot backfill is the single catch-all for new gyms; if a provisioning flow is ever added, call `seedExerciseCatalog(client, newTenantId)` at the end of it. The browse/use UI is `app/dashboard/exercises/page.tsx` + `ExerciseLibraryGrid.tsx` (search + category filter, rich cards, add/delete). Do NOT introduce a shared catalog table to "dedupe" rows — that trades the isolation guarantee for marginal storage savings on small reference text.
