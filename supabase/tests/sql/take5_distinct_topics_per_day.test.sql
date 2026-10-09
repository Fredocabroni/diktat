-- Behavioral test: Take 5 distinct-topic counter (P3.a).
-- Migration: 20261011000000_take5_distinct_topics_per_day.sql
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file
--
-- Covers:
--   T1  First shift on topic A → progress 0 → 1.
--   T2  Second shift on topic A by same user (stance flip, fresh
--       client_key) → progress stays at 1. noop_reason stamped.
--   T3  First shift on topic B by same user → progress 1 → 2.
--   T4  Five taps on one topic by one user → progress ends at 1.
--   T5  Five distinct topics by one user → progress ends at 5.
--   T6  Day rollover: a shift today-local resets progress to 1 even if
--       the (user, topic) pair had shifts on a prior local day.
--
-- Each case calls record_opinion_shift (the only client-reachable INSERT
-- path for opinion_shifts), which fires the AFTER INSERT trigger. The
-- trigger invokes increment_take5_progress(uuid, uuid).

begin;

-- -----------------------------------------------------------------------------
-- Fixture: three users + six topics.
-- -----------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'a1111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'a1@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a2222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'a2@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a3333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated', 'a3@test.local', now(), now());

insert into public.news_topics (id, slug, headline, source_title, is_drop, drop_at) values
  ('a0000000-aaaa-aaaa-aaaa-000000000001', 'p3a-topic-a', 'Topic A', 'Topic A', true, now()),
  ('a0000000-aaaa-aaaa-aaaa-000000000002', 'p3a-topic-b', 'Topic B', 'Topic B', true, now()),
  ('a0000000-aaaa-aaaa-aaaa-000000000003', 'p3a-topic-c', 'Topic C', 'Topic C', true, now()),
  ('a0000000-aaaa-aaaa-aaaa-000000000004', 'p3a-topic-d', 'Topic D', 'Topic D', true, now()),
  ('a0000000-aaaa-aaaa-aaaa-000000000005', 'p3a-topic-e', 'Topic E', 'Topic E', true, now()),
  ('a0000000-aaaa-aaaa-aaaa-000000000006', 'p3a-topic-f', 'Topic F', 'Topic F', true, now());

-- -----------------------------------------------------------------------------
-- T1 — First shift on topic A → progress goes 0 → 1.
-- -----------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"a1111111-1111-1111-1111-111111111111","role":"authenticated"}';

do $$
declare
  v_before int;
  v_after  int;
begin
  select coalesce(take5_progress, 0) into v_before
    from public.streaks where user_id = 'a1111111-1111-1111-1111-111111111111';

  perform public.record_opinion_shift(
    p_topic_id       => 'a0000000-aaaa-aaaa-aaaa-000000000001',
    p_after_position => 1::smallint,
    p_client_key     => gen_random_uuid()
  );

  select coalesce(take5_progress, 0) into v_after
    from public.streaks where user_id = 'a1111111-1111-1111-1111-111111111111';
  if v_after <> v_before + 1 then
    raise exception 'T1 FAIL: progress %→% (want %→%)', v_before, v_after, v_before, v_before + 1;
  end if;
  raise notice 'T1 PASS: first shift on topic A → progress %→%', v_before, v_after;
end $$;

-- -----------------------------------------------------------------------------
-- T2 — Second shift on topic A by same user (stance flip, fresh key) →
--      progress stays unchanged. noop_reason stamped by the writer.
-- -----------------------------------------------------------------------------
do $$
declare
  v_before int;
  v_after  int;
  v_writer_result jsonb;
begin
  select coalesce(take5_progress, 0) into v_before
    from public.streaks where user_id = 'a1111111-1111-1111-1111-111111111111';

  perform public.record_opinion_shift(
    p_topic_id       => 'a0000000-aaaa-aaaa-aaaa-000000000001',
    p_after_position => -1::smallint, -- flip to disagree
    p_client_key     => gen_random_uuid()
  );

  select coalesce(take5_progress, 0) into v_after
    from public.streaks where user_id = 'a1111111-1111-1111-1111-111111111111';
  if v_after <> v_before then
    raise exception 'T2 FAIL: progress advanced on flip (before=%, after=%)', v_before, v_after;
  end if;

  -- Direct writer invocation to verify the noop_reason field.
  select public.increment_take5_progress(
    'a1111111-1111-1111-1111-111111111111',
    'a0000000-aaaa-aaaa-aaaa-000000000001'
  ) into v_writer_result;
  if v_writer_result ->> 'noop_reason' is distinct from 'already_counted_this_topic_today' then
    raise exception 'T2 FAIL: noop_reason=% (want already_counted_this_topic_today)',
      v_writer_result ->> 'noop_reason';
  end if;

  raise notice 'T2 PASS: stance flip on same topic → progress unchanged (%)', v_after;
end $$;

-- -----------------------------------------------------------------------------
-- T3 — First shift on topic B by same user → progress 1 → 2.
-- -----------------------------------------------------------------------------
do $$
declare
  v_before int;
  v_after  int;
begin
  select coalesce(take5_progress, 0) into v_before
    from public.streaks where user_id = 'a1111111-1111-1111-1111-111111111111';

  perform public.record_opinion_shift(
    p_topic_id       => 'a0000000-aaaa-aaaa-aaaa-000000000002',
    p_after_position => 1::smallint,
    p_client_key     => gen_random_uuid()
  );

  select coalesce(take5_progress, 0) into v_after
    from public.streaks where user_id = 'a1111111-1111-1111-1111-111111111111';
  if v_after <> v_before + 1 then
    raise exception 'T3 FAIL: progress %→% (want %→%)', v_before, v_after, v_before, v_before + 1;
  end if;
  raise notice 'T3 PASS: new topic → progress %→%', v_before, v_after;
end $$;

-- -----------------------------------------------------------------------------
-- T4 — Five taps on one topic by user2 → progress ends at exactly 1.
-- -----------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"a2222222-2222-2222-2222-222222222222","role":"authenticated"}';

do $$
declare
  v_progress int;
  v_i int;
begin
  for v_i in 1..5 loop
    perform public.record_opinion_shift(
      p_topic_id       => 'a0000000-aaaa-aaaa-aaaa-000000000001',
      p_after_position => case when v_i % 2 = 0 then -1 else 1 end::smallint,
      p_client_key     => gen_random_uuid()
    );
  end loop;

  select coalesce(take5_progress, 0) into v_progress
    from public.streaks where user_id = 'a2222222-2222-2222-2222-222222222222';
  if v_progress <> 1 then
    raise exception 'T4 FAIL: 5 taps on one topic → progress=% (want 1)', v_progress;
  end if;
  raise notice 'T4 PASS: 5 taps on one topic → progress=1';
end $$;

-- -----------------------------------------------------------------------------
-- T5 — Five distinct topics by user3 → progress ends at exactly 5.
-- -----------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"a3333333-3333-3333-3333-333333333333","role":"authenticated"}';

do $$
declare
  v_progress int;
  v_topics uuid[] := ARRAY[
    'a0000000-aaaa-aaaa-aaaa-000000000001',
    'a0000000-aaaa-aaaa-aaaa-000000000002',
    'a0000000-aaaa-aaaa-aaaa-000000000003',
    'a0000000-aaaa-aaaa-aaaa-000000000004',
    'a0000000-aaaa-aaaa-aaaa-000000000005'
  ];
  v_t uuid;
begin
  foreach v_t in array v_topics loop
    perform public.record_opinion_shift(
      p_topic_id       => v_t,
      p_after_position => 1::smallint,
      p_client_key     => gen_random_uuid()
    );
  end loop;

  select coalesce(take5_progress, 0) into v_progress
    from public.streaks where user_id = 'a3333333-3333-3333-3333-333333333333';
  if v_progress <> 5 then
    raise exception 'T5 FAIL: 5 distinct topics → progress=% (want 5)', v_progress;
  end if;
  raise notice 'T5 PASS: 5 distinct topics → progress=5';
end $$;

-- -----------------------------------------------------------------------------
-- T6 — Day rollover: a prior-day (user, topic) shift must not block today's
--      first shift from crediting. Simulate by backdating a prior shift and
--      calling the writer directly so we don't hit the record_opinion_shift
--      24h cap or the client_key uniqueness index.
-- -----------------------------------------------------------------------------
do $$
declare
  v_user_id uuid := 'a3333333-3333-3333-3333-333333333333';
  v_topic_id uuid := 'a0000000-aaaa-aaaa-aaaa-000000000006';
  v_tz text;
  v_today date;
  v_progress int;
  v_result jsonb;
begin
  select timezone into v_tz from public.users where id = v_user_id;
  v_today := (now() at time zone v_tz)::date;

  -- Pre-seed a backdated shift (yesterday-local). Disable trigger so this
  -- seed row doesn't bump progress itself.
  alter table public.opinion_shifts disable trigger opinion_shifts_take5_after_insert;
  insert into public.opinion_shifts (user_id, topic_id, before_position, after_position, client_key, created_at)
    values (
      v_user_id, v_topic_id, 0::smallint, 1::smallint, gen_random_uuid(),
      (v_today - 1)::timestamp at time zone v_tz
    );
  alter table public.opinion_shifts enable trigger opinion_shifts_take5_after_insert;

  select take5_progress into v_progress from public.streaks where user_id = v_user_id;

  -- A real shift today on the same topic should credit (first shift
  -- today-local even though there is a prior-day shift).
  perform public.record_opinion_shift(
    p_topic_id       => v_topic_id,
    p_after_position => 1::smallint,
    p_client_key     => gen_random_uuid()
  );

  select take5_progress into v_progress from public.streaks where user_id = v_user_id;
  -- T5 ended at progress=5 — this topic (F) is the 6th distinct today, so
  -- progress should land at 6.
  if v_progress <> 6 then
    raise exception 'T6 FAIL: prior-day shift blocked today''s credit; progress=% (want 6)', v_progress;
  end if;
  raise notice 'T6 PASS: prior-day shift did not block today''s credit; progress=6';
end $$;

-- -----------------------------------------------------------------------------
-- T6b — Streaks row missing-but-recreatable: the function must guarantee
--       a row to FOR UPDATE before locking. Simulate by deleting the
--       user's streaks row, then invoking the function via the full
--       record_opinion_shift path. The trigger's increment_take5_progress
--       call should re-create the row (ON CONFLICT DO NOTHING) and credit
--       progress correctly. (Operator question on the second-round fix:
--       what if the streaks row doesn't exist?)
-- -----------------------------------------------------------------------------
do $$
declare
  v_user_id uuid := 'a3333333-3333-3333-3333-333333333333';
  v_fresh_topic uuid := 'a0000000-aaaa-aaaa-aaaa-00000000000f';
  v_progress int;
begin
  -- Fresh topic for this user; delete the streaks row to simulate a
  -- hypothetical pre-handle_new_user state.
  insert into public.news_topics (id, slug, headline, source_title, is_drop, drop_at)
    values (v_fresh_topic, 'p3a-topic-g-recreate', 'Topic G recreate', 'Topic G recreate', true, now());
  delete from public.streaks where user_id = v_user_id;

  perform public.record_opinion_shift(
    p_topic_id       => v_fresh_topic,
    p_after_position => 1::smallint,
    p_client_key     => gen_random_uuid()
  );

  -- The function must have recreated the row AND credited progress to 1
  -- for this first-shift-on-first-topic-today case.
  select take5_progress into v_progress
    from public.streaks where user_id = v_user_id;
  if v_progress is null then
    raise exception 'T6b FAIL: streaks row still missing after shift';
  end if;
  if v_progress <> 1 then
    raise exception 'T6b FAIL: expected progress=1 after row recreate, got %', v_progress;
  end if;
  raise notice 'T6b PASS: missing streaks row recreated + progress credited to 1';
end $$;

-- -----------------------------------------------------------------------------
-- T7 — Phantom-credit guard: direct service_role call with no backing
--      opinion_shifts row MUST NOT credit progress. In the AFTER INSERT
--      trigger context this branch is unreachable (v_shift_count >= 1
--      always), so this is a direct-RPC-call sanity check.
--      (security-reviewer PR #196 Medium — v2.)
-- -----------------------------------------------------------------------------
do $$
declare
  v_user_id uuid := 'a3333333-3333-3333-3333-333333333333';
  v_fake_topic uuid := '00000000-0000-0000-0000-000000000000';
  v_before_progress int;
  v_after_progress  int;
  v_result jsonb;
begin
  select coalesce(take5_progress, 0) into v_before_progress
    from public.streaks where user_id = v_user_id;

  -- Direct call with a topic the user has NOT shifted on today.
  -- Must return error + leave progress unchanged.
  select public.increment_take5_progress(v_user_id, v_fake_topic) into v_result;

  if v_result ->> 'error' is distinct from 'no_shift_row' then
    raise exception 'T7 FAIL: expected error=no_shift_row, got %', v_result;
  end if;

  select coalesce(take5_progress, 0) into v_after_progress
    from public.streaks where user_id = v_user_id;
  if v_after_progress <> v_before_progress then
    raise exception 'T7 FAIL: phantom credit advanced progress %→%',
      v_before_progress, v_after_progress;
  end if;

  raise notice 'T7 PASS: phantom-credit guard rejected direct call with no backing shift row';
end $$;

-- -----------------------------------------------------------------------------
-- Note on concurrent-writer coverage (security-reviewer PR #196 Medium 2).
-- -----------------------------------------------------------------------------
-- Michael asked for a SQL test on "two concurrent shifts on different topics."
-- A single-session psql test cannot express cross-session concurrency because:
--   * `pg_advisory_xact_lock` and `SELECT ... FOR UPDATE` are session-scoped;
--     a single psql transaction cannot simulate two concurrent transactions.
--   * psql itself has no fork / multi-connection primitive.
--   * dblink or pg_background could spin a second session, but introduces
--     cross-session commit ordering complexity that would make the test
--     flakier than the lock it is trying to exercise.
--
-- The migration's defence against the race lives on two layers, both in-tree:
--   * `record_opinion_shift` (migration 20261010000000, line 119) acquires a
--     per-user `pg_advisory_xact_lock` BEFORE the INSERT. The AFTER INSERT
--     trigger (and the `increment_take5_progress` call inside it) runs in
--     the same transaction, so two concurrent client calls for one user
--     serialise cleanly at the RPC boundary.
--   * `increment_take5_progress` (this migration, step 2) also acquires
--     `SELECT 1 FROM public.streaks WHERE user_id = p_user_id FOR UPDATE`
--     at the top. This defends against any FUTURE writer that bypasses
--     `record_opinion_shift` (e.g. a service-role backfill): the FOR UPDATE
--     holds for the trigger's transaction, serialising the count-check +
--     streaks UPDATE pair regardless of how the opinion_shifts row arrived.
--
-- Together these form belt-and-braces coverage; an adversary would have to
-- bypass BOTH the per-user advisory lock AND the per-user streaks row lock
-- to double-credit a topic.

rollback;
