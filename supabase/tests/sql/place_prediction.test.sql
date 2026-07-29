-- Behavioral test: place_prediction atomically debits AP + the direct-insert
-- hole is closed (migration 20260729120000_predictions_drop_insert_self_add_place_rpc).
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file
-- Connection is the postgres superuser → owns + may EXECUTE the SECURITY DEFINER
-- function. Proves the debit/balance-check/ledger at the DB layer, independent
-- of any tRPC path (there is none — the RPC is intentionally un-wired).
--
-- place_prediction derives the caller from auth.uid(), so each call runs with a
-- simulated JWT via the `request.jwt.claims` GUC. Fixture user is created the
-- canonical way: insert into auth.users and let handle_new_user() auto-provision
-- public.users (current_ap default 100); we then set current_ap = 500 pre-state.

begin;

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'a1111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'pp@test.local', now(), now());

update public.users set current_ap = 500 where id = 'a1111111-1111-1111-1111-111111111111';

insert into public.news_topics (id, slug, headline) values
  ('d0000000-0000-4000-8000-000000000001', 'place-prediction-test-topic', 'Test topic for place_prediction');

-- Simulate an authenticated request for the fixture user. auth.uid() reads
-- ->>'sub' off this claims blob (same pattern as battle_participants_rls.test.sql).
set local request.jwt.claims = '{"sub":"a1111111-1111-1111-1111-111111111111","role":"authenticated"}';

-- ---------------------------------------------------------------------------
-- T1: stake 100 of 500 AP on 'yes'. Assert the atomic debit, the open
-- prediction row, and the exact prediction_stake ledger row.
-- ---------------------------------------------------------------------------
do $$
declare
  v_uid uuid := 'a1111111-1111-1111-1111-111111111111';
  v_topic uuid := 'd0000000-0000-4000-8000-000000000001';
  v_pred_id uuid;
  v_ap integer;
  p record;
  t record;
begin
  v_pred_id := public.place_prediction(v_topic, 'yes', 100, null);

  -- Debit landed.
  select current_ap into v_ap from public.users where id = v_uid;
  if v_ap <> 400 then raise exception 'T1 FAIL current_ap=% (want 400)', v_ap; end if;

  -- Prediction row is open, un-settled, correct stake/direction/owner.
  select * into p from public.predictions where id = v_pred_id;
  if p.user_id <> v_uid then raise exception 'T1 FAIL prediction user_id=%', p.user_id; end if;
  if p.topic_id <> v_topic then raise exception 'T1 FAIL prediction topic_id=%', p.topic_id; end if;
  if p.direction <> 'yes' then raise exception 'T1 FAIL direction=%', p.direction; end if;
  if p.ap_stake <> 100 then raise exception 'T1 FAIL ap_stake=%', p.ap_stake; end if;
  if p.status <> 'open' then raise exception 'T1 FAIL status=%', p.status; end if;
  if p.ap_payout is not null then raise exception 'T1 FAIL ap_payout not null: %', p.ap_payout; end if;
  if p.settled_at is not null then raise exception 'T1 FAIL settled_at not null'; end if;

  -- Exactly one ledger row, a correct debit, keyed to the prediction.
  select * into t from public.ap_transactions where reason = 'prediction_stake' and user_id = v_uid;
  if t.delta <> -100 then raise exception 'T1 FAIL ledger delta=% (want -100)', t.delta; end if;
  if t.balance_after <> 400 then raise exception 'T1 FAIL ledger balance_after=% (want 400)', t.balance_after; end if;
  if t.ref_type <> 'prediction' then raise exception 'T1 FAIL ledger ref_type=%', t.ref_type; end if;
  if t.ref_id <> v_pred_id then raise exception 'T1 FAIL ledger ref_id=%', t.ref_id; end if;
  if t.idempotency_key <> 'prediction_stake:' || v_pred_id::text then
    raise exception 'T1 FAIL ledger idempotency_key=%', t.idempotency_key;
  end if;

  raise notice 'T1 PASS: 500->400 debited atomically, open prediction + prediction_stake ledger row written';
end $$;

-- ---------------------------------------------------------------------------
-- T2: stake more AP than the user holds. Assert insufficient_ap raises and the
-- whole call rolls back — no partial debit, no orphan prediction/ledger row.
-- ---------------------------------------------------------------------------
do $$
declare
  v_uid uuid := 'a1111111-1111-1111-1111-111111111111';
  v_topic uuid := 'd0000000-0000-4000-8000-000000000001';
  v_ap integer;
  v_preds integer;
  v_ledgers integer;
begin
  begin
    perform public.place_prediction(v_topic, 'no', 100000, null);
    raise exception 'T2 FAIL: expected insufficient_ap, no error raised';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'insufficient_ap' then raise exception 'T2 FAIL wrong error: %', sqlerrm; end if;
  end;

  -- No partial effect: balance unchanged, still exactly one prediction + one ledger row (from T1).
  select current_ap into v_ap from public.users where id = v_uid;
  if v_ap <> 400 then raise exception 'T2 FAIL current_ap moved on reject=% (want 400)', v_ap; end if;
  select count(*) into v_preds from public.predictions where user_id = v_uid;
  if v_preds <> 1 then raise exception 'T2 FAIL prediction count=% (want 1)', v_preds; end if;
  select count(*) into v_ledgers from public.ap_transactions where reason = 'prediction_stake' and user_id = v_uid;
  if v_ledgers <> 1 then raise exception 'T2 FAIL stake ledger count=% (want 1)', v_ledgers; end if;

  raise notice 'T2 PASS: insufficient_ap rejects with no partial debit and no orphan rows';
end $$;

-- ---------------------------------------------------------------------------
-- T3: the dropped policy — a direct authenticated INSERT into predictions is
-- now rejected (no permissive insert path remains). Must run as the
-- `authenticated` role, since the superuser bypasses RLS.
-- ---------------------------------------------------------------------------
set local role authenticated;
do $$
begin
  begin
    insert into public.predictions (topic_id, user_id, direction, ap_stake, status)
      values ('d0000000-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111', 'yes', 1, 'open');
    raise exception 'T3 FAIL: direct authenticated insert succeeded (predictions_insert_self not dropped?)';
  exception when sqlstate '42501' then
    raise notice 'T3 PASS: direct authenticated insert into predictions rejected (%)', sqlerrm;
  end;
end $$;
reset role;

rollback;
\echo 'ALL ASSERTIONS PASSED'
