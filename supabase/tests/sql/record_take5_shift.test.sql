-- Behavioral test: record_take5_shift RPC + take5_sessions table.
-- Migration: 20261105000000_take5_sessions.sql
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file
--
-- Covers:
--   T1 Happy path — one Take 5 stance writes opinion_shifts + take5_sessions
--      + advances Take 5 streak progress via the existing trigger.
--   T2 Stance flip on the same topic — second RPC call does NOT create a
--      second take5_sessions row (UNIQUE user_id,topic_id); cards_today
--      stays at 1; opinion_shifts has 2 rows (recorded flip).
--   T3 Daily cap — the 6th distinct-topic stance in one ET day raises
--      sqlstate 54000 (program_limit_exceeded).
--   T4 Unauthenticated caller — raise 28000.
--   T5 take5_sessions RLS — a different user cannot SELECT this user's rows.

begin;

-- -----------------------------------------------------------------------------
-- Fixture: two users + six topics.
-- -----------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'ba111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'ba1@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'ba222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'ba2@test.local', now(), now());

insert into public.news_topics (id, slug, headline, source_title, is_drop, drop_at) values
  ('b0000000-aaaa-aaaa-aaaa-000000000001', 't5-topic-a', 'Topic A', 'Topic A', true, now()),
  ('b0000000-aaaa-aaaa-aaaa-000000000002', 't5-topic-b', 'Topic B', 'Topic B', true, now()),
  ('b0000000-aaaa-aaaa-aaaa-000000000003', 't5-topic-c', 'Topic C', 'Topic C', true, now()),
  ('b0000000-aaaa-aaaa-aaaa-000000000004', 't5-topic-d', 'Topic D', 'Topic D', true, now()),
  ('b0000000-aaaa-aaaa-aaaa-000000000005', 't5-topic-e', 'Topic E', 'Topic E', true, now()),
  ('b0000000-aaaa-aaaa-aaaa-000000000006', 't5-topic-f', 'Topic F', 'Topic F', true, now());

create function pg_temp.expect_sqlstate(
  write_sql text, expected_sqlstate text, label text
) returns void
language plpgsql as $$
declare v_state text;
begin
  begin
    execute write_sql;
    raise exception 'expected sqlstate % for %, but call succeeded',
      expected_sqlstate, label;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state is distinct from expected_sqlstate then
      raise exception 'expected sqlstate %, got % for %',
        expected_sqlstate, v_state, label;
    end if;
  end;
end$$;

-- -----------------------------------------------------------------------------
-- T1 — Happy path. First Take 5 stance for user ba1 on topic A.
-- -----------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"ba111111-1111-1111-1111-111111111111","role":"authenticated"}';

do $$
declare
  v_streak_before int;
  v_streak_after  int;
  v_cards_today   int;
  v_shift_id      uuid;
  r               record;
begin
  select coalesce(take5_progress, 0) into v_streak_before
    from public.streaks where user_id = 'ba111111-1111-1111-1111-111111111111';

  for r in
    select * from public.record_take5_shift(
      p_topic_id       => 'b0000000-aaaa-aaaa-aaaa-000000000001',
      p_after_position => 1::smallint,
      p_client_key     => gen_random_uuid()
    )
  loop
    v_shift_id := r.shift_id;
    v_cards_today := r.cards_today;
  end loop;

  if v_shift_id is null then
    raise exception 'T1 FAIL: shift_id null';
  end if;
  if v_cards_today <> 1 then
    raise exception 'T1 FAIL: cards_today = % (want 1)', v_cards_today;
  end if;

  -- opinion_shifts row exists
  if not exists (select 1 from public.opinion_shifts where id = v_shift_id) then
    raise exception 'T1 FAIL: opinion_shifts row missing';
  end if;
  -- take5_sessions row exists linked to the shift
  if not exists (
    select 1 from public.take5_sessions
     where shift_id = v_shift_id
       and user_id = 'ba111111-1111-1111-1111-111111111111'
       and topic_id = 'b0000000-aaaa-aaaa-aaaa-000000000001'
  ) then
    raise exception 'T1 FAIL: take5_sessions row missing';
  end if;
  -- Streak progress advanced via the trigger.
  select coalesce(take5_progress, 0) into v_streak_after
    from public.streaks where user_id = 'ba111111-1111-1111-1111-111111111111';
  if v_streak_after <> v_streak_before + 1 then
    raise exception 'T1 FAIL: streak progress %→% (want %→%)',
      v_streak_before, v_streak_after, v_streak_before, v_streak_before + 1;
  end if;
  raise notice 'T1 PASS: happy path, cards_today=%, streak %→%',
    v_cards_today, v_streak_before, v_streak_after;
end $$;

-- -----------------------------------------------------------------------------
-- T2 — Stance flip on same topic. UNIQUE (user_id, topic_id) keeps
-- take5_sessions at 1 row; opinion_shifts gets a second row (the flip);
-- cards_today stays at 1.
-- -----------------------------------------------------------------------------
do $$
declare
  v_sessions_before int;
  v_sessions_after  int;
  v_shifts_before   int;
  v_shifts_after    int;
  v_cards_today     int;
  r                 record;
begin
  select count(*) into v_sessions_before
    from public.take5_sessions
   where user_id = 'ba111111-1111-1111-1111-111111111111'
     and topic_id = 'b0000000-aaaa-aaaa-aaaa-000000000001';
  select count(*) into v_shifts_before
    from public.opinion_shifts
   where user_id = 'ba111111-1111-1111-1111-111111111111'
     and topic_id = 'b0000000-aaaa-aaaa-aaaa-000000000001';

  for r in
    select * from public.record_take5_shift(
      p_topic_id       => 'b0000000-aaaa-aaaa-aaaa-000000000001',
      p_after_position => -1::smallint,  -- flip
      p_client_key     => gen_random_uuid()
    )
  loop
    v_cards_today := r.cards_today;
  end loop;

  select count(*) into v_sessions_after
    from public.take5_sessions
   where user_id = 'ba111111-1111-1111-1111-111111111111'
     and topic_id = 'b0000000-aaaa-aaaa-aaaa-000000000001';
  select count(*) into v_shifts_after
    from public.opinion_shifts
   where user_id = 'ba111111-1111-1111-1111-111111111111'
     and topic_id = 'b0000000-aaaa-aaaa-aaaa-000000000001';

  if v_sessions_after <> v_sessions_before then
    raise exception 'T2 FAIL: take5_sessions should stay at % (got %)',
      v_sessions_before, v_sessions_after;
  end if;
  if v_shifts_after <> v_shifts_before + 1 then
    raise exception 'T2 FAIL: opinion_shifts should grow by 1 (% → %)',
      v_shifts_before, v_shifts_after;
  end if;
  if v_cards_today <> 1 then
    raise exception 'T2 FAIL: cards_today = % (want 1)', v_cards_today;
  end if;
  raise notice 'T2 PASS: flip left take5_sessions at %, opinion_shifts grew %→%',
    v_sessions_after, v_shifts_before, v_shifts_after;
end $$;

-- -----------------------------------------------------------------------------
-- T3 — Daily cap. Stance on topics B..E (4 more → total 5 cards today),
-- then F should raise 54000.
-- -----------------------------------------------------------------------------
do $$
begin
  perform public.record_take5_shift(
    p_topic_id       => 'b0000000-aaaa-aaaa-aaaa-000000000002',
    p_after_position => 1::smallint,
    p_client_key     => gen_random_uuid()
  );
  perform public.record_take5_shift(
    p_topic_id       => 'b0000000-aaaa-aaaa-aaaa-000000000003',
    p_after_position => 1::smallint,
    p_client_key     => gen_random_uuid()
  );
  perform public.record_take5_shift(
    p_topic_id       => 'b0000000-aaaa-aaaa-aaaa-000000000004',
    p_after_position => 1::smallint,
    p_client_key     => gen_random_uuid()
  );
  perform public.record_take5_shift(
    p_topic_id       => 'b0000000-aaaa-aaaa-aaaa-000000000005',
    p_after_position => 1::smallint,
    p_client_key     => gen_random_uuid()
  );
end $$;

-- 6th distinct topic → cap exceeded.
select pg_temp.expect_sqlstate(
  $sql$ select public.record_take5_shift(
          p_topic_id       => 'b0000000-aaaa-aaaa-aaaa-000000000006'::uuid,
          p_after_position => 1::smallint,
          p_client_key     => gen_random_uuid()
        ) $sql$,
  '54000',
  'T3: take5 daily cap of 5 cards per ET day'
);

-- -----------------------------------------------------------------------------
-- T4 — Unauthenticated. Clear the JWT; expect 28000.
-- -----------------------------------------------------------------------------
reset request.jwt.claims;
select pg_temp.expect_sqlstate(
  $sql$ select public.record_take5_shift(
          p_topic_id       => 'b0000000-aaaa-aaaa-aaaa-000000000002'::uuid,
          p_after_position => 1::smallint,
          p_client_key     => gen_random_uuid()
        ) $sql$,
  '28000',
  'T4: unauthenticated caller rejected'
);

-- -----------------------------------------------------------------------------
-- T5 — RLS SELECT scoping. User ba2 must not see user ba1's take5_sessions rows.
-- -----------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"ba222222-2222-2222-2222-222222222222","role":"authenticated"}';
-- Simulate the authenticated role for RLS evaluation.
set local role authenticated;

do $$
declare
  v_seen int;
begin
  select count(*) into v_seen from public.take5_sessions
   where user_id = 'ba111111-1111-1111-1111-111111111111';
  if v_seen <> 0 then
    raise exception 'T5 FAIL: user ba2 saw % rows belonging to user ba1', v_seen;
  end if;
  raise notice 'T5 PASS: cross-user SELECT returned 0 rows';
end $$;

reset role;

rollback;

\echo record_take5_shift.test.sql: ok
