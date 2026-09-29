-- Behavioral test: Q2 of the invariant monitor
-- ---------------------------------------------
-- prediction_missing_stake: a prediction created in the last 7d MUST have a
-- matching public.ap_transactions row with
--   ref_type='prediction', ref_id=p.id,
--   reason='prediction_stake',
--   user_id = p.user_id,
--   delta   = -p.ap_stake.
-- Q2 fires when no such row exists.
--
-- Fixture handling: BAD rows are hand-inserted. LEGIT rows go through the
-- real writer -- public.place_prediction(topic, direction, ap_stake, market)
-- via a simulated JWT so auth.uid() resolves to the fixture user. A
-- writer-side rename (ref_type, reason, key format) breaks the LEGIT case
-- here, catching drift.
--
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file

begin;

-- ---------------------------------------------------------------------------
-- Fixture users + a topic. handle_new_user() auto-provisions public.users.
-- ---------------------------------------------------------------------------
-- First 10 hex chars must differ per user (see handle_new_user()).
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'a2000001-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'iq2-a@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b2000001-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'iq2-b@test.local', now(), now());

update public.users set current_ap = 500 where id in (
  'a2000001-0000-0000-0000-000000000001',
  'b2000001-0000-0000-0000-000000000002'
);

insert into public.news_topics (id, slug, headline) values
  ('d2000000-0000-4000-8000-000000000001', 'iq2-test-topic', 'Test topic for prediction_missing_stake');

-- ---------------------------------------------------------------------------
-- The invariant query, sourced from apps/workers/src/jobs/invariant-check.ts
-- (SQL_PREDICTION_MISSING_STAKE).
-- ---------------------------------------------------------------------------
create or replace function pg_temp.q2_count() returns integer language sql as $$
  select count(*)::int from (
    select p.id
    from public.predictions p
    where p.created_at >= now() - interval '7 days'
      and p.ap_stake > 0
      and not exists (
        select 1 from public.ap_transactions t
        where t.ref_type = 'prediction'
          and t.ref_id   = p.id
          and t.reason   = 'prediction_stake'
          and t.user_id  = p.user_id
          and t.delta    = -p.ap_stake
      )
    order by p.created_at desc
    limit 6
  ) s
$$;

do $$
declare
  n integer;
begin
  n := pg_temp.q2_count();
  if n <> 0 then raise exception 'baseline FAIL: Q2 returned % on empty fixture', n; end if;
  raise notice 'baseline PASS: Q2 = 0 on empty fixture';
end $$;

-- ---------------------------------------------------------------------------
-- BAD-1: hand-inserted prediction with NO ledger row. Q2 must fire.
-- ---------------------------------------------------------------------------
insert into public.predictions (id, topic_id, user_id, direction, ap_stake, status)
values (
  'ee200001-0000-0000-0000-000000000001',
  'd2000000-0000-4000-8000-000000000001',
  'a2000001-0000-0000-0000-000000000001',
  'yes', 25, 'open'
);

do $$
declare
  n integer;
begin
  n := pg_temp.q2_count();
  if n <> 1 then raise exception 'BAD-1 FAIL: expected 1, got %', n; end if;
  raise notice 'BAD-1 PASS: prediction with no ledger triggers Q2';
end $$;

-- ---------------------------------------------------------------------------
-- BAD-wrong-user: prediction for user A, but the ledger row's user_id is B.
-- Q2 must fire (staker-identity mismatch).
-- ---------------------------------------------------------------------------
insert into public.predictions (id, topic_id, user_id, direction, ap_stake, status)
values (
  'ee200001-0000-0000-0000-000000000002',
  'd2000000-0000-4000-8000-000000000001',
  'a2000001-0000-0000-0000-000000000001',
  'yes', 25, 'open'
);

insert into public.ap_transactions (
  user_id, delta, balance_after, reason, ref_type, ref_id, idempotency_key
) values (
  -- Wrong user: B pays for A's prediction.
  'b2000001-0000-0000-0000-000000000002',
  -25, 475, 'prediction_stake', 'prediction',
  'ee200001-0000-0000-0000-000000000002',
  'test:iq2:bad-wrong-user'
);

do $$
declare
  n integer;
begin
  n := pg_temp.q2_count();
  if n <> 2 then raise exception 'BAD-wrong-user FAIL: expected 2, got %', n; end if;
  raise notice 'BAD-wrong-user PASS: user_id mismatch triggers Q2';
end $$;

-- ---------------------------------------------------------------------------
-- BAD-wrong-debit: prediction ap_stake=25 but ledger delta=-10. Q2 must fire.
-- ---------------------------------------------------------------------------
insert into public.predictions (id, topic_id, user_id, direction, ap_stake, status)
values (
  'ee200001-0000-0000-0000-000000000003',
  'd2000000-0000-4000-8000-000000000001',
  'a2000001-0000-0000-0000-000000000001',
  'yes', 25, 'open'
);

insert into public.ap_transactions (
  user_id, delta, balance_after, reason, ref_type, ref_id, idempotency_key
) values (
  'a2000001-0000-0000-0000-000000000001',
  -10, 490, 'prediction_stake', 'prediction',
  'ee200001-0000-0000-0000-000000000003',
  'test:iq2:bad-wrong-debit'
);

do $$
declare
  n integer;
begin
  n := pg_temp.q2_count();
  if n <> 3 then raise exception 'BAD-wrong-debit FAIL: expected 3, got %', n; end if;
  raise notice 'BAD-wrong-debit PASS: delta mismatch triggers Q2';
end $$;

-- ---------------------------------------------------------------------------
-- LEGIT-correct: call the real place_prediction as user A. That RPC writes
-- the prediction AND the matching prediction_stake ledger row atomically.
-- Q2 count must stay at 3 (previous BAD state unchanged).
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"a2000001-0000-0000-0000-000000000001","role":"authenticated"}';

do $$
declare
  v_pred_id uuid;
begin
  v_pred_id := public.place_prediction(
    'd2000000-0000-4000-8000-000000000001'::uuid,
    'no'::text,
    50::int,
    null::text
  );
  if v_pred_id is null then raise exception 'LEGIT-correct FAIL: place_prediction returned null'; end if;
end $$;

-- Drop back to postgres for the assertion (it uses count(*) via a temp fn).
reset role;
set local request.jwt.claims to '';

do $$
declare
  n integer;
begin
  n := pg_temp.q2_count();
  if n <> 3 then raise exception 'LEGIT-correct FAIL: expected 3 (no new violation), got %', n; end if;
  raise notice 'LEGIT-correct PASS: place_prediction stays silent';
end $$;

-- ---------------------------------------------------------------------------
-- LEGIT-outside-window: prediction created 8 days ago, no ledger. Q2 must
-- NOT count it (outside the 7d window).
-- ---------------------------------------------------------------------------
insert into public.predictions (id, topic_id, user_id, direction, ap_stake, status, created_at, updated_at)
values (
  'ee200001-0000-0000-0000-000000000005',
  'd2000000-0000-4000-8000-000000000001',
  'a2000001-0000-0000-0000-000000000001',
  'yes', 25, 'open',
  now() - interval '8 days', now() - interval '8 days'
);

do $$
declare
  n integer;
begin
  n := pg_temp.q2_count();
  if n <> 3 then raise exception 'LEGIT-outside-window FAIL: expected 3, got %', n; end if;
  raise notice 'LEGIT-outside-window PASS: >7d silent';
end $$;

rollback;

\echo 'invariant_check_predictions.test.sql — all cases passed'
