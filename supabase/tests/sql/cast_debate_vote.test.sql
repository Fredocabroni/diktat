-- Behavioral test: cast_debate_vote RPC + the dropped debate_votes_insert_self
-- policy (migration 20260730120000, security fix #114).
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file
--
-- The RPC derives the voter from auth.uid(); each call sets a simulated JWT via
-- the request.jwt.claims GUC (same pattern as place_prediction.test.sql /
-- battle_participants_rls.test.sql). Fixture users are created the canonical way
-- (insert into auth.users → handle_new_user trigger auto-provisions public.users
-- with current_ap default 100).

begin;

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'a1111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'a1@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b2222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'b2@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c3333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated', 'c3@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd4444444-4444-4444-4444-444444444444', 'authenticated', 'authenticated', 'd4@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e5555555-5555-5555-5555-555555555555', 'authenticated', 'authenticated', 'e5@test.local', now(), now());

-- Voter c3 gets a distinctive AP so we can prove the snapshot is SERVER-read.
update public.users set current_ap = 500 where id = 'c3333333-3333-3333-3333-333333333333';

-- bb: open votable battle (verdict round awaiting_final_vote, deadline in future).
-- cc: verdict round awaiting_final_vote but deadline PAST.
-- dd: a round NOT in awaiting_final_vote (no open votable round).
insert into public.battles (id, mode) values
  ('00000000-0000-0000-0000-0000000000bb', 'open_debate'),
  ('00000000-0000-0000-0000-0000000000cc', 'open_debate'),
  ('00000000-0000-0000-0000-0000000000dd', 'open_debate');

insert into public.battle_participants (battle_id, user_id, seat, entry_ap) values
  ('00000000-0000-0000-0000-0000000000bb', 'a1111111-1111-1111-1111-111111111111', 0, 100),
  ('00000000-0000-0000-0000-0000000000bb', 'b2222222-2222-2222-2222-222222222222', 1, 100);

insert into public.battle_rounds (battle_id, round_no, payload, deadline_at) values
  ('00000000-0000-0000-0000-0000000000bb', 3, '{"state":"awaiting_final_vote"}'::jsonb, now() + interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000cc', 3, '{"state":"awaiting_final_vote"}'::jsonb, now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000dd', 3, '{"state":"revealed"}'::jsonb, now() + interval '1 hour');

set local request.jwt.claims = '{"sub":"c3333333-3333-3333-3333-333333333333","role":"authenticated"}';

-- ---------------------------------------------------------------------------
-- T1: happy path — c3 (non-participant) votes for a1. Assert ap_at_vote_time is
-- the SERVER-read current_ap (500), not any client value.
-- ---------------------------------------------------------------------------
do $$
declare v_id uuid; v_ap integer; v_for uuid;
begin
  v_id := public.cast_debate_vote(
    '00000000-0000-0000-0000-0000000000bb', 'a1111111-1111-1111-1111-111111111111');
  if v_id is null then raise exception 'T1 FAIL: no vote id returned'; end if;
  select ap_at_vote_time, vote_for_user_id into v_ap, v_for
    from public.debate_votes where battle_id = '00000000-0000-0000-0000-0000000000bb'
      and voter_user_id = 'c3333333-3333-3333-3333-333333333333';
  if v_ap <> 500 then raise exception 'T1 FAIL: ap_at_vote_time=% (want 500, server-read)', v_ap; end if;
  if v_for <> 'a1111111-1111-1111-1111-111111111111' then raise exception 'T1 FAIL: vote_for=%', v_for; end if;
  raise notice 'T1 PASS: vote recorded with server-read ap_at_vote_time=500 (unforgeable)';
end $$;

-- ---------------------------------------------------------------------------
-- T2: double vote — c3 votes again → unique(battle_id, voter_user_id) → 23505.
-- ---------------------------------------------------------------------------
do $$
begin
  perform public.cast_debate_vote(
    '00000000-0000-0000-0000-0000000000bb', 'a1111111-1111-1111-1111-111111111111');
  raise exception 'T2 FAIL: expected already-voted (23505)';
exception when sqlstate '23505' then raise notice 'T2 PASS: double vote rejected';
end $$;

-- ---------------------------------------------------------------------------
-- T3: participant a1 tries to vote → DK001.
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"a1111111-1111-1111-1111-111111111111","role":"authenticated"}';
do $$
begin
  perform public.cast_debate_vote(
    '00000000-0000-0000-0000-0000000000bb', 'b2222222-2222-2222-2222-222222222222');
  raise exception 'T3 FAIL: expected DK001';
exception when sqlstate 'DK001' then raise notice 'T3 PASS: participant cannot vote (DK001)';
end $$;

-- ---------------------------------------------------------------------------
-- T4: d4 votes for e5 (not a participant) → DK002.
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"d4444444-4444-4444-4444-444444444444","role":"authenticated"}';
do $$
begin
  perform public.cast_debate_vote(
    '00000000-0000-0000-0000-0000000000bb', 'e5555555-5555-5555-5555-555555555555');
  raise exception 'T4 FAIL: expected DK002';
exception when sqlstate 'DK002' then raise notice 'T4 PASS: vote_for non-participant rejected (DK002)';
end $$;

-- ---------------------------------------------------------------------------
-- T5: no round in awaiting_final_vote (battle dd) → DK003 (checked before participation).
-- ---------------------------------------------------------------------------
do $$
begin
  perform public.cast_debate_vote(
    '00000000-0000-0000-0000-0000000000dd', 'a1111111-1111-1111-1111-111111111111');
  raise exception 'T5 FAIL: expected DK003';
exception when sqlstate 'DK003' then raise notice 'T5 PASS: voting not open (DK003)';
end $$;

-- ---------------------------------------------------------------------------
-- T6: verdict round open but deadline PAST (battle cc) → DK004.
-- ---------------------------------------------------------------------------
do $$
begin
  perform public.cast_debate_vote(
    '00000000-0000-0000-0000-0000000000cc', 'a1111111-1111-1111-1111-111111111111');
  raise exception 'T6 FAIL: expected DK004';
exception when sqlstate 'DK004' then raise notice 'T6 PASS: expired window rejected (DK004)';
end $$;

-- ---------------------------------------------------------------------------
-- T7: the dropped policy — a direct authenticated INSERT into debate_votes is
-- now rejected (the RPC is the only writer). Must run as role authenticated.
-- ---------------------------------------------------------------------------
set local role authenticated;
do $$
begin
  insert into public.debate_votes (battle_id, voter_user_id, vote_for_user_id, ap_at_vote_time)
    values ('00000000-0000-0000-0000-0000000000bb', 'd4444444-4444-4444-4444-444444444444',
            'a1111111-1111-1111-1111-111111111111', 999999999);
  raise exception 'T7 FAIL: direct authenticated insert succeeded (policy not dropped?)';
exception when sqlstate '42501' then raise notice 'T7 PASS: direct insert rejected — RPC is the only writer';
end $$;
reset role;

rollback;
\echo 'ALL ASSERTIONS PASSED'
