-- Catalog test: bp_insert_self is gone (migration 20261127000000,
-- insert-policy sweep finding F1). Verifies:
--   (T1) no INSERT policy for roles authenticated/anon remains on
--        public.battle_participants;
--   (T2) the SELECT policies (bp_select_self,
--        battle_participants_select_open_debate_observers) still
--        exist — the read surface is unchanged;
--   (T3) RLS is still enabled on the table.
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file

begin;

-- T1: no INSERT policy for authenticated/anon on battle_participants.
do $$
declare
  v_count integer;
  v_names text;
begin
  select count(*), coalesce(string_agg(policyname, ', '), '')
    into v_count, v_names
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'battle_participants'
     and cmd        = 'INSERT'
     and roles && array['authenticated', 'anon']::name[];
  if v_count <> 0 then
    raise exception 'T1 FAIL: client INSERT policy still present on battle_participants (count=%, names=%)', v_count, v_names;
  end if;
  raise notice 'T1 PASS: no authenticated/anon INSERT policy on battle_participants';
end $$;

-- T2a: bp_select_self still exists.
do $$
declare
  v_count integer;
begin
  select count(*)
    into v_count
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'battle_participants'
     and policyname = 'bp_select_self';
  if v_count <> 1 then
    raise exception 'T2a FAIL: bp_select_self missing (count=%)', v_count;
  end if;
  raise notice 'T2a PASS: bp_select_self stays';
end $$;

-- T2b: the open-debate observer SELECT policy still exists.
do $$
declare
  v_count integer;
begin
  select count(*)
    into v_count
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'battle_participants'
     and policyname = 'battle_participants_select_open_debate_observers';
  if v_count <> 1 then
    raise exception 'T2b FAIL: battle_participants_select_open_debate_observers missing (count=%)', v_count;
  end if;
  raise notice 'T2b PASS: open-debate observer select policy stays';
end $$;

-- T3: RLS is still enabled on the table.
do $$
declare
  v_enabled boolean;
begin
  select c.relrowsecurity
    into v_enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'battle_participants';
  if v_enabled is not true then
    raise exception 'T3 FAIL: RLS is not enabled on battle_participants (relrowsecurity=%)', v_enabled;
  end if;
  raise notice 'T3 PASS: RLS still enabled on battle_participants';
end $$;

rollback;
\echo 'ALL bp_insert_self DROP ASSERTIONS PASSED (T1-T3)'
