-- Behavioral test: submit_debate_argument RPC + the dropped
-- debate_args_insert_self policy (migration 20261128000000, sweep F2,
-- docs/audits/2026-11-insert-policy-sweep.md).
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file
--
-- The RPC derives the submitter from auth.uid(); each test sets the
-- simulated JWT via the request.jwt.claims GUC (same pattern as
-- cast_debate_vote.test.sql). Fixture users are created the canonical
-- way (insert into auth.users -> handle_new_user trigger seeds
-- public.users).

begin;

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'a1111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'arg-a1@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b2222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'arg-b2@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c3333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated', 'arg-c3@test.local', now(), now());

-- Two open-debate battles:
--   aa: round 0 awaiting_arguments, deadline in future (happy path).
--   bb: round 0 awaiting_arguments, deadline PAST (DA003).
-- A verdict round (round_no=3) also exists on aa for the DA001 test.
insert into public.battles (id, mode) values
  ('00000000-0000-0000-0000-0000000000aa', 'open_debate'),
  ('00000000-0000-0000-0000-0000000000bb', 'open_debate');

insert into public.battle_participants (battle_id, user_id, seat, entry_ap) values
  ('00000000-0000-0000-0000-0000000000aa', 'a1111111-1111-1111-1111-111111111111', 0, 0),
  ('00000000-0000-0000-0000-0000000000aa', 'b2222222-2222-2222-2222-222222222222', 1, 0),
  ('00000000-0000-0000-0000-0000000000bb', 'a1111111-1111-1111-1111-111111111111', 0, 0),
  ('00000000-0000-0000-0000-0000000000bb', 'b2222222-2222-2222-2222-222222222222', 1, 0);

insert into public.battle_rounds (id, battle_id, round_no, payload, deadline_at) values
  ('11111111-1111-1111-1111-11111111aa01', '00000000-0000-0000-0000-0000000000aa', 0,
     '{"state":"awaiting_arguments"}'::jsonb, now() + interval '1 hour'),
  ('11111111-1111-1111-1111-11111111aa03', '00000000-0000-0000-0000-0000000000aa', 3,
     '{"state":"awaiting_final_vote"}'::jsonb, now() + interval '1 hour'),
  ('11111111-1111-1111-1111-11111111bb01', '00000000-0000-0000-0000-0000000000bb', 0,
     '{"state":"awaiting_arguments"}'::jsonb, now() - interval '1 hour');

-- 100-char filler argument (meets the column CHECK's lower bound).
-- 100 repetitions of 'x' = exactly 100 characters.
-- ---------------------------------------------------------------------------
-- T1: non-participant rejected (DA004). c3 is not on battle aa.
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"c3333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform public.submit_debate_argument(
    '11111111-1111-1111-1111-11111111aa01', repeat('x', 100));
  raise exception 'T1 FAIL: non-participant was allowed to submit (DA004 expected)';
exception when sqlstate 'DA004' then
  raise notice 'T1 PASS: non-participant rejected (DA004)';
end $$;

-- ---------------------------------------------------------------------------
-- T2: after deadline rejected (DA003). a1 is a participant on battle bb but
--     bb's round-0 deadline has already passed.
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"a1111111-1111-1111-1111-111111111111","role":"authenticated"}';
do $$
begin
  perform public.submit_debate_argument(
    '11111111-1111-1111-1111-11111111bb01', repeat('x', 100));
  raise exception 'T2 FAIL: past-deadline submission was accepted (DA003 expected)';
exception when sqlstate 'DA003' then
  raise notice 'T2 PASS: past-deadline rejected (DA003)';
end $$;

-- ---------------------------------------------------------------------------
-- T3: participant before deadline accepted. a1 on battle aa, round 0, open.
--     Verify a row lands with the server-derived user_id (= auth.uid()).
-- ---------------------------------------------------------------------------
do $$
declare v_id uuid; v_user uuid;
begin
  v_id := public.submit_debate_argument(
    '11111111-1111-1111-1111-11111111aa01', repeat('y', 100));
  if v_id is null then raise exception 'T3 FAIL: no argument id returned'; end if;
  select user_id into v_user from public.debate_arguments where id = v_id;
  if v_user <> 'a1111111-1111-1111-1111-111111111111' then
    raise exception 'T3 FAIL: user_id=% (want server-derived a1)', v_user;
  end if;
  raise notice 'T3 PASS: participant submission accepted, user_id = auth.uid()';
end $$;

-- ---------------------------------------------------------------------------
-- T4: no direct PostgREST insert possible. The dropped
--     debate_args_insert_self policy + revoked INSERT grant mean a role
--     `authenticated` INSERT must fail. 42501 = permission denied.
-- ---------------------------------------------------------------------------
set local role authenticated;
do $$
begin
  insert into public.debate_arguments (battle_id, round_id, user_id, text)
    values ('00000000-0000-0000-0000-0000000000aa',
            '11111111-1111-1111-1111-11111111aa01',
            'b2222222-2222-2222-2222-222222222222',
            repeat('z', 100));
  raise exception 'T4 FAIL: direct authenticated insert succeeded (policy/grant not removed?)';
exception when sqlstate '42501' then
  raise notice 'T4 PASS: direct authenticated insert rejected -- RPC is the only writer';
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- T5 (catalog): no INSERT policy for authenticated/anon remains on
--     public.debate_arguments. Mirrors the sweep's INERT-vs-H3 contract:
--     the only valid INSERT path is the SECURITY DEFINER RPC.
-- ---------------------------------------------------------------------------
do $$
declare
  v_count integer;
  v_names text;
begin
  select count(*), coalesce(string_agg(policyname, ', '), '')
    into v_count, v_names
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'debate_arguments'
     and cmd        = 'INSERT'
     and roles && array['authenticated', 'anon']::name[];
  if v_count <> 0 then
    raise exception 'T5 FAIL: client INSERT policy still present on debate_arguments (count=%, names=%)', v_count, v_names;
  end if;
  raise notice 'T5 PASS: no authenticated/anon INSERT policy on debate_arguments';
end $$;

rollback;
\echo 'ALL submit_debate_argument ASSERTIONS PASSED (T1-T5)'
