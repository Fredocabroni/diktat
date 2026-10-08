-- Behavioral test: record_opinion_shift RPC (#145, migration 20261010000000).
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file
--
-- Each case sets a simulated JWT via `request.jwt.claims` GUC (same pattern as
-- cast_debate_vote.test.sql / place_prediction.test.sql). Fixture users are
-- created the canonical way (insert into auth.users → handle_new_user trigger
-- auto-provisions public.users with current_ap default 100 + streaks row).
--
-- Trigger non-fire on ON CONFLICT path is verified by observing that
-- `public.streaks.take5_progress` for the caller does NOT advance a second
-- time when the same (user_id, client_key) is re-submitted. The after-insert
-- trigger `opinion_shifts_take5_after_insert` fires only on real INSERTs; ON
-- CONFLICT DO NOTHING is a NO-OP and must leave the counter untouched.

begin;

-- -----------------------------------------------------------------------------
-- Fixture: two human users + one topic. `slug` is NOT NULL on news_topics;
-- `headline` is NOT NULL. Everything else carries a default.
-- -----------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'f1111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'f1@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'f2222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'f2@test.local', now(), now());

insert into public.news_topics (id, slug, headline, source_title, is_drop, drop_at) values
  ('11111111-aaaa-aaaa-aaaa-111111111111', 'rpc145-test-topic', 'Test headline — #145 RPC', 'test', true, now());

-- T8 pre-seeds 50 historical opinion_shifts for user f2 to exercise the
-- rolling-24h cap. Done up here at fixture-setup time (same privilege
-- context as the auth.users / news_topics inserts) so the trigger disable
-- does not require elevated privilege inside a JWT-scoped block. The 50
-- rows live for the full transaction; T8's savepoint rollback below is
-- unnecessary now but kept for clarity. #179 security-reviewer F5.
alter table public.opinion_shifts disable trigger opinion_shifts_take5_after_insert;
insert into public.opinion_shifts (user_id, topic_id, before_position, after_position, client_key, created_at)
select 'f2222222-2222-2222-2222-222222222222',
       '11111111-aaaa-aaaa-aaaa-111111111111',
       0::smallint, 1::smallint,
       gen_random_uuid(),
       now() - (gs || ' minutes')::interval
  from generate_series(1, 50) gs;
alter table public.opinion_shifts enable trigger opinion_shifts_take5_after_insert;

-- -----------------------------------------------------------------------------
-- T1 — happy path. First shift on this topic. before_position defaults to 0.
-- Trigger fires exactly once, so take5_progress goes 0 → 1.
-- -----------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"f1111111-1111-1111-1111-111111111111","role":"authenticated"}';

do $$
declare
  v_row public.opinion_shifts;
  v_progress_before integer;
  v_progress_after  integer;
  v_client_key uuid := '11111111-1111-1111-1111-111111111111';
begin
  select coalesce(take5_progress, 0) into v_progress_before
    from public.streaks where user_id = 'f1111111-1111-1111-1111-111111111111';

  v_row := public.record_opinion_shift(
    p_topic_id       => '11111111-aaaa-aaaa-aaaa-111111111111',
    p_after_position => 1::smallint,
    p_client_key     => v_client_key
  );

  if v_row.id is null then
    raise exception 'T1 FAIL: returned row has null id';
  end if;
  if v_row.user_id <> 'f1111111-1111-1111-1111-111111111111' then
    raise exception 'T1 FAIL: user_id was not derived from auth.uid() (got %)', v_row.user_id;
  end if;
  if v_row.before_position <> 0 then
    raise exception 'T1 FAIL: before_position=% (want 0 for first-time)', v_row.before_position;
  end if;
  if v_row.after_position <> 1 then
    raise exception 'T1 FAIL: after_position=% (want 1)', v_row.after_position;
  end if;
  if v_row.client_key <> v_client_key then
    raise exception 'T1 FAIL: client_key not persisted (got %)', v_row.client_key;
  end if;

  select coalesce(take5_progress, 0) into v_progress_after
    from public.streaks where user_id = 'f1111111-1111-1111-1111-111111111111';
  if v_progress_after <> v_progress_before + 1 then
    raise exception 'T1 FAIL: take5_progress did not advance (before=%, after=%)',
      v_progress_before, v_progress_after;
  end if;

  raise notice 'T1 PASS: first shift inserted, before_position=0, take5_progress advanced by 1';
end $$;

-- -----------------------------------------------------------------------------
-- T2 — idempotent retry. Same (user_id, client_key) must NO-OP: return the
-- same row id AND leave take5_progress unchanged (the AFTER INSERT trigger
-- must NOT re-fire on the ON CONFLICT DO NOTHING path).
-- -----------------------------------------------------------------------------
do $$
declare
  v_row public.opinion_shifts;
  v_progress_before integer;
  v_progress_after  integer;
  v_original_id uuid;
  v_client_key uuid := '11111111-1111-1111-1111-111111111111';
begin
  select id into v_original_id
    from public.opinion_shifts
   where user_id = 'f1111111-1111-1111-1111-111111111111'
     and client_key = v_client_key;

  select coalesce(take5_progress, 0) into v_progress_before
    from public.streaks where user_id = 'f1111111-1111-1111-1111-111111111111';

  v_row := public.record_opinion_shift(
    p_topic_id       => '11111111-aaaa-aaaa-aaaa-111111111111',
    p_after_position => 1::smallint,
    p_client_key     => v_client_key
  );

  if v_row.id <> v_original_id then
    raise exception 'T2 FAIL: retry returned different id (orig=%, got=%)',
      v_original_id, v_row.id;
  end if;

  select coalesce(take5_progress, 0) into v_progress_after
    from public.streaks where user_id = 'f1111111-1111-1111-1111-111111111111';
  if v_progress_after <> v_progress_before then
    raise exception 'T2 FAIL: take5_progress advanced on retry (before=%, after=%). AFTER INSERT trigger double-credited.',
      v_progress_before, v_progress_after;
  end if;

  raise notice 'T2 PASS: same client_key no-ops; trigger did not re-fire';
end $$;

-- -----------------------------------------------------------------------------
-- T3 — change of mind. Fresh client_key on the SAME topic writes a new row,
-- and before_position is snapshotted from the prior shift's after_position (1).
-- -----------------------------------------------------------------------------
do $$
declare
  v_row public.opinion_shifts;
begin
  v_row := public.record_opinion_shift(
    p_topic_id       => '11111111-aaaa-aaaa-aaaa-111111111111',
    p_after_position => (-1)::smallint,
    p_client_key     => '22222222-2222-2222-2222-222222222222'
  );
  if v_row.before_position <> 1 then
    raise exception 'T3 FAIL: before_position=% (want 1, snapshot of prior after_position)',
      v_row.before_position;
  end if;
  if v_row.after_position <> -1 then
    raise exception 'T3 FAIL: after_position=%', v_row.after_position;
  end if;
  raise notice 'T3 PASS: change-of-mind inserted; before_position snapshotted server-side';
end $$;

-- -----------------------------------------------------------------------------
-- T4 — legacy path. NULL client_key always writes a fresh row (partial index
-- skips NULLs; no conflict can fire). Confirms the rollout-window path.
-- -----------------------------------------------------------------------------
do $$
declare
  v_row1 public.opinion_shifts;
  v_row2 public.opinion_shifts;
begin
  v_row1 := public.record_opinion_shift(
    p_topic_id       => '11111111-aaaa-aaaa-aaaa-111111111111',
    p_after_position => 1::smallint,
    p_client_key     => null
  );
  v_row2 := public.record_opinion_shift(
    p_topic_id       => '11111111-aaaa-aaaa-aaaa-111111111111',
    p_after_position => 1::smallint,
    p_client_key     => null
  );
  if v_row1.id = v_row2.id then
    raise exception 'T4 FAIL: NULL-client_key insert deduped (should always write)';
  end if;
  raise notice 'T4 PASS: NULL client_key path writes fresh rows every call';
end $$;

-- -----------------------------------------------------------------------------
-- T5 — topic not found. Clean P0002 at RPC boundary (not raw FK 23503).
-- -----------------------------------------------------------------------------
do $$
begin
  perform public.record_opinion_shift(
    p_topic_id       => '00000000-0000-0000-0000-000000000000',
    p_after_position => 1::smallint,
    p_client_key     => '33333333-3333-3333-3333-333333333333'
  );
  raise exception 'T5 FAIL: expected P0002 topic-not-found';
exception when sqlstate 'P0002' then
  raise notice 'T5 PASS: unknown topic → P0002';
end $$;

-- -----------------------------------------------------------------------------
-- T6 — bad after_position (out of range). Raises 22023 (invalid parameter).
-- -----------------------------------------------------------------------------
do $$
begin
  perform public.record_opinion_shift(
    p_topic_id       => '11111111-aaaa-aaaa-aaaa-111111111111',
    p_after_position => 5::smallint,
    p_client_key     => '44444444-4444-4444-4444-444444444444'
  );
  raise exception 'T6 FAIL: expected 22023 for after_position=5';
exception when sqlstate '22023' then
  raise notice 'T6 PASS: out-of-range after_position → 22023';
end $$;

-- -----------------------------------------------------------------------------
-- T7 — unauthenticated. No request.jwt.claims → auth.uid() is NULL → 28000.
-- Scope the GUC reset to a nested transaction so it doesn't contaminate
-- subsequent tests.
-- -----------------------------------------------------------------------------
savepoint before_unauth;
set local request.jwt.claims = '';
do $$
begin
  perform public.record_opinion_shift(
    p_topic_id       => '11111111-aaaa-aaaa-aaaa-111111111111',
    p_after_position => 1::smallint,
    p_client_key     => '55555555-5555-5555-5555-555555555555'
  );
  raise exception 'T7 FAIL: expected 28000 unauthenticated';
exception when sqlstate '28000' then
  raise notice 'T7 PASS: no auth.uid() → 28000';
end $$;
rollback to savepoint before_unauth;

-- -----------------------------------------------------------------------------
-- T8 — rolling-24h cap. User f2 has 50 historical opinion_shifts pre-seeded
-- in the fixture section (above the JWT blocks). The 51st call must raise
-- 54000 (program_limit_exceeded).
-- -----------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"f2222222-2222-2222-2222-222222222222","role":"authenticated"}';

do $$
begin
  perform public.record_opinion_shift(
    p_topic_id       => '11111111-aaaa-aaaa-aaaa-111111111111',
    p_after_position => 1::smallint,
    p_client_key     => '66666666-6666-6666-6666-666666666666'
  );
  raise exception 'T8 FAIL: expected 54000 rate limit';
exception when sqlstate '54000' then
  raise notice 'T8 PASS: 50 shifts/24h cap → 54000';
end $$;

-- -----------------------------------------------------------------------------
-- T9 — idempotency wins over the rolling-24h cap. User f1 crosses the cap
-- with their 50th shift (p_client_key = K); a retry with the same K must
-- return the recorded row, NOT raise 54000. This is #179 schema-reviewer
-- F-RATELIMIT-IDEM: the cap-first ordering would have broken the client_key
-- idempotency contract (migration 20260930000000) at exactly the boundary
-- where a lost ack is most likely.
--
-- Fixture: pre-seed 49 trigger-silent rows for f1 (the T1-T4 happy-path
-- block already added 3 keyed + 2 NULL rows; add 44 more to reach 49).
-- The 50th shift is a real call under JWT so the trigger fires; the 51st
-- call is the retry with the same client_key.
-- -----------------------------------------------------------------------------
savepoint before_t9;
alter table public.opinion_shifts disable trigger opinion_shifts_take5_after_insert;
insert into public.opinion_shifts (user_id, topic_id, before_position, after_position, client_key, created_at)
select 'f1111111-1111-1111-1111-111111111111',
       '11111111-aaaa-aaaa-aaaa-111111111111',
       0::smallint, 1::smallint,
       gen_random_uuid(),
       now() - (gs || ' minutes')::interval
  from generate_series(100, 144) gs;  -- 45 more rows, non-overlapping times
alter table public.opinion_shifts enable trigger opinion_shifts_take5_after_insert;

set local request.jwt.claims = '{"sub":"f1111111-1111-1111-1111-111111111111","role":"authenticated"}';

do $$
declare
  v_row public.opinion_shifts;
  v_count_before integer;
  v_count_after  integer;
  v_retry_row public.opinion_shifts;
  v_crossing_key uuid := '77777777-7777-7777-7777-777777777777';
begin
  select count(*) into v_count_before
    from public.opinion_shifts
   where user_id = 'f1111111-1111-1111-1111-111111111111'
     and created_at > now() - interval '24 hours';
  -- Sanity: this test depends on exactly 49 live rows in the 24h window
  -- for f1 (T1 + T3 + T4×2 + T9 preseed×44 + T2 was a no-op on T1's key
  -- so adds nothing = 1+1+2+44 = 48; cap trips on the 50th row insert).
  -- The exact count is less important than "cap must fire on the next
  -- INSERT"; T9's 50th call takes the user past the boundary.
  if v_count_before < 48 or v_count_before > 50 then
    raise exception 'T9 FIXTURE WARN: unexpected baseline count=% (expected 48-50)', v_count_before;
  end if;

  -- The 50th shift (fresh key). Cap is at 50; a count < 50 passes.
  v_row := public.record_opinion_shift(
    p_topic_id       => '11111111-aaaa-aaaa-aaaa-111111111111',
    p_after_position => 1::smallint,
    p_client_key     => v_crossing_key
  );
  if v_row.id is null then
    raise exception 'T9 FAIL: 50th shift returned null row';
  end if;

  -- Retry with the SAME key. The naive cap-first path would see count=50
  -- (or 51) and raise 54000. The fast-path returns the recorded row.
  v_retry_row := public.record_opinion_shift(
    p_topic_id       => '11111111-aaaa-aaaa-aaaa-111111111111',
    p_after_position => 1::smallint,
    p_client_key     => v_crossing_key
  );
  if v_retry_row.id <> v_row.id then
    raise exception 'T9 FAIL: retry returned different id (orig=%, got=%)',
      v_row.id, v_retry_row.id;
  end if;

  -- Belt-and-suspenders: a FRESH key at the cap boundary should still
  -- raise 54000. If this stops firing, the fast-path has broken the cap.
  begin
    perform public.record_opinion_shift(
      p_topic_id       => '11111111-aaaa-aaaa-aaaa-111111111111',
      p_after_position => 1::smallint,
      p_client_key     => '88888888-8888-8888-8888-888888888888'
    );
    raise exception 'T9 FAIL: fresh-key call past the cap did not raise 54000';
  exception when sqlstate '54000' then
    -- expected
    null;
  end;

  raise notice 'T9 PASS: idempotent retry wins over cap; fresh key past cap still 54000';
end $$;
rollback to savepoint before_t9;

rollback;
