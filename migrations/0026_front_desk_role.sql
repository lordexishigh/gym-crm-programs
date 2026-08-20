-- 0026_front_desk_role.sql
--
-- Front Desk Staff: a third `users.role`, plus the DB-layer half of its
-- permissions.
--
-- The blueprint names three staff personas (Gym Owner, Trainer, Front Desk) but
-- `users.role` only ever allowed 'owner' | 'trainer', so a front-desk account
-- literally could not be created — the check constraint rejected it. This adds
-- the role and, with it, the guarantee that the role means something below the
-- application layer.
--
-- WHY RESTRICTIVE POLICIES
--
-- Every existing staff policy is PERMISSIVE and keyed on app_current_role() =
-- 'staff'; permissive policies are OR-ed, so narrowing one role by editing them
-- would mean touching ~30 policies across ten migrations and getting all of
-- them right. RESTRICTIVE policies are AND-ed with whatever else matched, so one
-- policy subtracts exactly the access being denied and leaves the
-- owner/trainer/member paths byte-for-byte unchanged: their `app.staff_role` is
-- 'owner'/'trainer' or empty, which makes every predicate below trivially true.
--
-- The application guard (lib/auth/session.ts `requireCapability`) is the primary
-- gate — it is what produces an explained redirect rather than a silently empty
-- page. These policies are the backstop for the case where that guard is what
-- fails: a Server Action added later that forgets the check still cannot write a
-- program or read a payment as a front-desk session.

-- ---------------------------------------------------------------------------
-- 1. Allow the role to exist. The constraint from 0001 is inline and unnamed, so
--    Postgres named it `users_role_check`; drop-then-add keeps this re-runnable.
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('owner', 'trainer', 'front_desk'));

-- ---------------------------------------------------------------------------
-- 2. Identity helpers. `app.staff_role` is stamped by lib/db.ts
--    withTenantContext from the server-verified `users` row — never from
--    anything the browser sends. Empty (every member session, and any staff path
--    that has not resolved a job role) reads as "not front desk", which is why
--    the predicates below are written as denials of one specific value.
create or replace function app_current_staff_role() returns text
  language sql stable as $$
    select coalesce(nullif(current_setting('app.staff_role', true), ''), 'none')
$$;

create or replace function app_is_front_desk() returns boolean
  language sql stable as $$
    select app_current_staff_role() = 'front_desk'
$$;

create or replace function app_current_user_id() returns uuid
  language sql stable as $$
    select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- 3. Program authoring is closed to front desk — for WRITES only.
--
-- Reads stay open on purpose: the member detail page shows which program a
-- member is on and when they last trained, and that is exactly the lookup the
-- front desk exists to do. What they must not do is author or reassign, so
-- INSERT/UPDATE/DELETE are denied and SELECT is untouched. (Opening the builder
-- at all is refused earlier, by `requireCapability("programs.read")`.)
--
-- A loop rather than 18 hand-written policies: the predicate is identical on
-- every table, and spelling it out six times is six chances to leave one off.
-- Three policies per table because one FOR ALL restrictive policy cannot express
-- "reads yes, writes no" — DELETE consults only USING, INSERT only WITH CHECK.
do $$
declare
  t text;
begin
  foreach t in array array[
    'program', 'exercise', 'program_assignment',
    'exercise_library', 'program_template', 'template_exercise'
  ] loop
    execute format('drop policy if exists %I on %I', t || '_front_desk_no_insert', t);
    execute format('drop policy if exists %I on %I', t || '_front_desk_no_update', t);
    execute format('drop policy if exists %I on %I', t || '_front_desk_no_delete', t);

    execute format(
      'create policy %I on %I as restrictive for insert'
      ' with check (not app_is_front_desk())',
      t || '_front_desk_no_insert', t);
    execute format(
      'create policy %I on %I as restrictive for update'
      ' using (not app_is_front_desk()) with check (not app_is_front_desk())',
      t || '_front_desk_no_update', t);
    execute format(
      'create policy %I on %I as restrictive for delete'
      ' using (not app_is_front_desk())',
      t || '_front_desk_no_delete', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Payment records are closed to front desk entirely — reads included. This is
--    the one denial that has to cover SELECT: "cannot view payment records" is
--    the requirement, and a restrictive USING makes those rows invisible even to
--    a query that reaches the table by another route (a join from the member
--    page, say) rather than through a guarded screen.
drop policy if exists membership_plans_front_desk_denied on membership_plans;
create policy membership_plans_front_desk_denied on membership_plans
  as restrictive for all
  using (not app_is_front_desk())
  with check (not app_is_front_desk());

drop policy if exists member_plans_front_desk_denied on member_plans;
create policy member_plans_front_desk_denied on member_plans
  as restrictive for all
  using (not app_is_front_desk())
  with check (not app_is_front_desk());

drop policy if exists payment_events_front_desk_denied on payment_events;
create policy payment_events_front_desk_denied on payment_events
  as restrictive for all
  using (not app_is_front_desk())
  with check (not app_is_front_desk());

-- ---------------------------------------------------------------------------
-- 5. Staff administration is closed to front desk: they may read their OWN
--    `users` row — that read is how the role is resolved in the first place
--    (lib/staff.ts getStaffRole), so denying it outright would make the role
--    unresolvable — and nothing else. No colleague list, and no write of any
--    kind: not their own role, not anyone else's.
drop policy if exists users_front_desk_self_only on users;
create policy users_front_desk_self_only on users
  as restrictive for all
  using (not app_is_front_desk() or auth_user_id = app_current_user_id())
  with check (not app_is_front_desk());
