-- 0001_init_schema.sql
-- Core tenanted schema for Alpha CRM (PostgreSQL 16).
--
-- Seven core models: gym (tenant), users (staff/trainer), member, invite,
-- program, exercise, program_assignment. Every tenant-scoped table carries a
-- tenant_id FK to gym(id). Composite (id, tenant_id) unique keys are used as
-- FK targets so child rows can only ever reference a parent in the SAME tenant
-- (schema-level cross-tenant integrity, complementing RLS in 0002).

-- gen_random_uuid() is provided by pgcrypto.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Unprivileged application role.
-- Tenant-scoped queries run as this role (via SET LOCAL ROLE app_user) so that
-- RLS policies apply. It is NOLOGIN: the app connects with the privileged
-- migration role and switches to app_user per transaction. It is created here
-- so migration 0002 can grant privileges and so the role exists before any
-- SET ROLE at runtime. Idempotent for re-runs against an existing database.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user nologin;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- gym (tenant)
create table if not exists gym (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- FK target for tenant-consistency composite FKs on child tables.
  constraint gym_id_unique unique (id)
);

-- ---------------------------------------------------------------------------
-- users (staff / trainer)
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references gym(id) on delete cascade,
  email         text not null,
  full_name     text,
  role          text not null default 'trainer' check (role in ('owner', 'trainer')),
  -- Maps to the Supabase Auth user once auth is wired (mvp-auth).
  auth_user_id  uuid unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint users_tenant_email_unique unique (tenant_id, email),
  constraint users_id_tenant_unique unique (id, tenant_id)
);
create index if not exists idx_users_tenant on users (tenant_id);

-- ---------------------------------------------------------------------------
-- member
create table if not exists member (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references gym(id) on delete cascade,
  email         text,
  full_name     text not null,
  status        text not null default 'active' check (status in ('active', 'inactive')),
  auth_user_id  uuid unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint member_id_tenant_unique unique (id, tenant_id)
);
create index if not exists idx_member_tenant on member (tenant_id);
create index if not exists idx_member_tenant_email on member (tenant_id, email);

-- ---------------------------------------------------------------------------
-- invite
create table if not exists invite (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references gym(id) on delete cascade,
  member_id   uuid,
  email       text not null,
  token_hash  text not null,
  status      text not null default 'pending'
                check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at  timestamptz,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  -- Tenant-consistent FKs: an invite's member/creator must be in the same gym.
  constraint invite_member_fk
    foreign key (member_id, tenant_id) references member (id, tenant_id) on delete cascade,
  constraint invite_creator_fk
    foreign key (created_by, tenant_id) references users (id, tenant_id) on delete set null (created_by)
);
create index if not exists idx_invite_tenant on invite (tenant_id);
create index if not exists idx_invite_token_hash on invite (token_hash);

-- ---------------------------------------------------------------------------
-- program
create table if not exists program (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references gym(id) on delete cascade,
  name        text not null,
  description text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint program_creator_fk
    foreign key (created_by, tenant_id) references users (id, tenant_id) on delete set null (created_by),
  -- FK target for exercise / program_assignment tenant-consistency.
  constraint program_id_tenant_unique unique (id, tenant_id)
);
create index if not exists idx_program_tenant on program (tenant_id);

-- ---------------------------------------------------------------------------
-- exercise (belongs to a program; tenant_id denormalized for RLS + indexing)
create table if not exists exercise (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references gym(id) on delete cascade,
  program_id  uuid not null,
  position    integer not null default 0,
  name        text not null,
  sets        integer,
  reps        text,
  rest        text,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint exercise_program_fk
    foreign key (program_id, tenant_id) references program (id, tenant_id) on delete cascade
);
create index if not exists idx_exercise_tenant on exercise (tenant_id);
create index if not exists idx_exercise_program_position on exercise (program_id, position);

-- ---------------------------------------------------------------------------
-- program_assignment (links a program to a member, both within one tenant)
create table if not exists program_assignment (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references gym(id) on delete cascade,
  program_id   uuid not null,
  member_id    uuid not null,
  assigned_by  uuid,
  status       text not null default 'active' check (status in ('active', 'archived')),
  assigned_at  timestamptz not null default now(),
  constraint assignment_program_fk
    foreign key (program_id, tenant_id) references program (id, tenant_id) on delete cascade,
  constraint assignment_member_fk
    foreign key (member_id, tenant_id) references member (id, tenant_id) on delete cascade,
  constraint assignment_assigner_fk
    foreign key (assigned_by, tenant_id) references users (id, tenant_id) on delete set null (assigned_by)
);
-- Assignment lookup indexes (the member-portal and staff lookups).
create index if not exists idx_assignment_tenant on program_assignment (tenant_id);
create index if not exists idx_assignment_tenant_member on program_assignment (tenant_id, member_id);
create index if not exists idx_assignment_tenant_program on program_assignment (tenant_id, program_id);
