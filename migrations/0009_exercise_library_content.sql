-- 0009_exercise_library_content.sql
-- Rich reference content for the exercise library (alpha-exercise-library-003).
--
-- Extends exercise_library so a catalog entry can carry teaching content:
-- an image, step-by-step instructions, form/safety guidelines, and coaching
-- tips — plus a `category` for grouping/search and an `is_seeded` flag that
-- marks the built-in starter catalog (seeded per gym by scripts/seed.mjs).
--
-- All new columns are NULLABLE (or carry a constant default), so existing rows
-- and every consumer (ProgramBuilder, the program pages, templates) keep working
-- unchanged — they simply do not select the columns they do not need. No RLS
-- change is required: the columns live on the already tenant-scoped
-- exercise_library table, and the table-level grant + `exercise_library_staff_all`
-- policy from 0003 cover the new columns automatically.

alter table exercise_library add column if not exists category     text;
alter table exercise_library add column if not exists image_url    text;
alter table exercise_library add column if not exists instructions text;
alter table exercise_library add column if not exists guidelines   text;
alter table exercise_library add column if not exists tips         text;
alter table exercise_library
  add column if not exists is_seeded boolean not null default false;

-- Findability: trainers browse/filter by category, and the built-in catalog is
-- surfaced first. Index (tenant_id, category) to keep that ordering cheap as a
-- gym's catalog grows. Free-text search uses ILIKE (handled in the page query).
create index if not exists idx_exercise_library_category
  on exercise_library (tenant_id, category);
