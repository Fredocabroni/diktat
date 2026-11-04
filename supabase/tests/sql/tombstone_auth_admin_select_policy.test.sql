-- Behavioural tests for migration 20261121000000: explicit
-- supabase_auth_admin SELECT policies on both tombstone tables.
--
-- The CI test harness connects as role `postgres`
-- (postgresql://postgres:postgres@127.0.0.1:54322/postgres). In the
-- Supabase CLI local DB that role is NOT a superuser and is NOT a
-- member of `supabase_auth_admin` (the local superuser is
-- `supabase_admin`), so `set local role supabase_auth_admin` fails
-- with `permission denied to set role "supabase_auth_admin"`. A
-- behavioural assertion that invokes hook_before_user_created under
-- the production role therefore isn't runnable from this harness.
-- Falling back to a `postgres` invocation would prove nothing
-- (postgres has BYPASSRLS, so the hook's SELECTs succeed whether or
-- not the new policies exist), so this file asserts the POLICY SHAPE
-- instead:
--
--   P3  Policy inventory — each table carries exactly one SELECT
--       policy whose target role list is {supabase_auth_admin}, and
--       supabase_auth_admin has SELECT privilege on both tables (the
--       privilege grant already exists from migration 20261120000000;
--       re-asserting it here guards against a future revoke drifting
--       past unnoticed).
--
-- Behavioural coverage of the hook read path under supabase_auth_admin
-- is a known gap. Options to close it, out of scope for this file:
--   (a) a separate CI step that runs ONLY this file via psql under
--       `supabase_admin` (the local superuser) so `set local role`
--       succeeds; or
--   (b) granting supabase_auth_admin membership to postgres in the
--       harness bootstrap, which keeps the single-psql test loop but
--       requires a CI workflow edit.

begin;

-- --------------------------------------------------------------------
-- P3: policy inventory + grant check.
-- --------------------------------------------------------------------
do $$
declare
  v_count int;
begin
  -- Exactly one SELECT policy, targeting only supabase_auth_admin.
  select count(*)
    into v_count
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'age_block_tombstones'
      and cmd        = 'SELECT'
      and roles      = array['supabase_auth_admin']::name[];
  if v_count <> 1 then
    raise exception 'P3: expected 1 SELECT-to-supabase_auth_admin policy on age_block_tombstones, got %',
      v_count;
  end if;

  select count(*)
    into v_count
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'age_block_identity_tombstones'
      and cmd        = 'SELECT'
      and roles      = array['supabase_auth_admin']::name[];
  if v_count <> 1 then
    raise exception 'P3: expected 1 SELECT-to-supabase_auth_admin policy on age_block_identity_tombstones, got %',
      v_count;
  end if;

  -- Underlying privilege grant still in place on both tables.
  if not has_table_privilege(
       'supabase_auth_admin', 'public.age_block_tombstones', 'SELECT'
     ) then
    raise exception 'P3: supabase_auth_admin lacks SELECT on age_block_tombstones';
  end if;

  if not has_table_privilege(
       'supabase_auth_admin', 'public.age_block_identity_tombstones', 'SELECT'
     ) then
    raise exception 'P3: supabase_auth_admin lacks SELECT on age_block_identity_tombstones';
  end if;
end
$$;

rollback;
