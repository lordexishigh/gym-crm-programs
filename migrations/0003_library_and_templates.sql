-- 0003_library_and_templates.sql
-- Exercise library + program templates (alpha-exercise-library-001/002).
--
-- NOTE: this file KEEPS its 0003 number even though two sibling files that once
-- shared the `0003_` prefix were renumbered to 0011/0012. It must run BEFORE
-- 0009 (adds columns to exercise_library) and 0010 (unique index on it), which
-- extend the exercise_library table created here. It is now the only `0003_`.
--
-- Adds three tenant-scoped tables that extend the authoring loop with reuse:
--   exercise_library  - a reusable per-gym catalog of exercises, independent of
--                       any program, that trainers insert into programs.
--   program_template  - a saved, reusable program shape (NOT assignable).
--   template_exercise - the ordered exercises belonging to a program_template.
--
-- Same conventions as 0001/0002: tenant_id FK to gym(id), composite
-- (id, tenant_id) unique keys as FK targets for cross-tenant integrity, and
-- staff-only RLS policies (these are trainer-authoring artifacts; members never
-- read them — a template is only ever instantiated into a real program, and a
-- library exercise is only ever copied into a program's exercise rows).

-- ---------------------------------------------------------------------------
-- exercise_library (reusable catalog; not tied to any program)
create table if not exists exercise_library (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references gym(id) on delete cascade,
  name        text not null,
  sets        integer,
  reps        text,
  rest        text,
  notes       text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint exercise_library_creator_fk
    foreign key (created_by, tenant_id) references users (id, tenant_id) on delete set null (created_by),
  constraint exercise_library_id_tenant_unique unique (id, tenant_id)
);
create index if not exists idx_exercise_library_tenant on exercise_library (tenant_id);

-- ---------------------------------------------------------------------------
-- program_template (saved program shape; instantiated into a real program)
create table if not exists program_template (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references gym(id) on delete cascade,
  name        text not null,
  description text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint program_template_creator_fk
    foreign key (created_by, tenant_id) references users (id, tenant_id) on delete set null (created_by),
  -- FK target for template_exercise tenant-consistency.
  constraint program_template_id_tenant_unique unique (id, tenant_id)
);
create index if not exists idx_program_template_tenant on program_template (tenant_id);

-- ---------------------------------------------------------------------------
-- template_exercise (belongs to a program_template; ordered by position)
create table if not exists template_exercise (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references gym(id) on delete cascade,
  template_id  uuid not null,
  position     integer not null default 0,
  name         text not null,
  sets         integer,
  reps         text,
  rest         text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint template_exercise_template_fk
    foreign key (template_id, tenant_id) references program_template (id, tenant_id) on delete cascade
);
create index if not exists idx_template_exercise_tenant on template_exercise (tenant_id);
create index if not exists idx_template_exercise_template_position
  on template_exercise (template_id, position);

-- ---------------------------------------------------------------------------
-- RLS: enable + force, staff-only tenant scoping (mirrors program/exercise).
alter table exercise_library  enable row level security;
alter table exercise_library  force  row level security;
alter table program_template  enable row level security;
alter table program_template  force  row level security;
alter table template_exercise enable row level security;
alter table template_exercise force  row level security;

drop policy if exists exercise_library_staff_all on exercise_library;
create policy exercise_library_staff_all on exercise_library
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

drop policy if exists program_template_staff_all on program_template;
create policy program_template_staff_all on program_template
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

drop policy if exists template_exercise_staff_all on template_exercise;
create policy template_exercise_staff_all on template_exercise
  for all
  using (tenant_id = app_current_tenant() and app_current_role() = 'staff')
  with check (tenant_id = app_current_tenant() and app_current_role() = 'staff');

-- ---------------------------------------------------------------------------
-- Privileges for the unprivileged app role (RLS still gates the rows).
grant select, insert, update, delete on
  exercise_library, program_template, template_exercise
  to app_user;
