-- 0010_exercise_library_seed_unique.sql
-- Conflict target for the idempotent built-in catalog seeder
-- (alpha-exercise-library-003).
--
-- seedExerciseCatalog (scripts/seed.mjs) upserts each built-in exercise with
-- `ON CONFLICT (tenant_id, lower(name)) DO UPDATE`, so re-running the seed (on
-- every boot, and for every gym) refreshes the built-in content in place
-- instead of duplicating rows. That conflict target needs a matching unique
-- index — created here. The expression `(tenant_id, lower(name))` makes the
-- uniqueness case-insensitive per gym, so "Back Squat" and "back squat" cannot
-- both exist in one library.
--
-- Idempotent (`if not exists`), so it is safe under the auto-migrate-on-boot
-- runner. If a gym already holds duplicate names (case-insensitively) this
-- CREATE will fail — that is the canonical check that the library is clean
-- before seeding; resolve the duplicates and re-run.

create unique index if not exists uq_exercise_library_tenant_name
  on exercise_library (tenant_id, lower(name));
