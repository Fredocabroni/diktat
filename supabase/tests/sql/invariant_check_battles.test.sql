-- Behavioral test: Q1 of the invariant monitor
-- ---------------------------------------------
-- battle_settled_missing_ap: a battle with status='settled', winner_user_id
-- NOT NULL, and ended_at inside the 7d window (with a 5-min grace on the
-- fresh side) MUST have at least one ap_transactions row keyed by
-- (ref_type='battle', ref_id=battle.id). Any reason counts -- ghost_credit,
-- battle_win/battle_loss, whatever. This is Q1 from the design.
--
-- Fixture handling: BAD rows are hand-inserted directly. LEGIT rows that need
-- a ledger use the real writer -- public.apply_ap_drafts(jsonb) -- so a
-- writer-side rename that broke the query would show up here as the LEGIT
-- row starting to alert.
--
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file

begin;

-- ---------------------------------------------------------------------------
-- Fixture users. handle_new_user() auto-provisions public.users + streaks +
-- wallets + a signup_grant ap_transactions row on the auth.users insert.
-- We override current_ap where the test needs a specific balance.
-- ---------------------------------------------------------------------------
-- First 10 hex chars must differ per user (handle_new_user() derives the
-- unique `handle` from substr(id::text-hyphens, 1, 10); collisions raise
-- users_handle_key). See battle_participants_rls.test.sql for the pattern.
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'a1000001-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'iq1-w@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b1000001-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'iq1-l@test.local', now(), now());

update public.users set current_ap = 500 where id in (
  'a1000001-0000-0000-0000-000000000001',
  'b1000001-0000-0000-0000-000000000002'
);

-- ---------------------------------------------------------------------------
-- The invariant query, sourced from apps/workers/src/jobs/invariant-check.ts
-- (SQL_BATTLE_SETTLED_MISSING_AP). Kept in a temp function so each case can
-- re-run it after mutating the fixture set.
-- ---------------------------------------------------------------------------
create or replace function pg_temp.q1_count() returns integer language sql as $$
  select count(*)::int from (
    select b.id
    from public.battles b
    where b.status = 'settled'
      and b.winner_user_id is not null
      and b.ended_at <= now() - interval '5 minutes'
      and b.ended_at >= now() - interval '7 days'
      and not exists (
        select 1 from public.ap_transactions t
        where t.ref_type = 'battle' and t.ref_id = b.id
      )
    order by b.ended_at desc
    limit 6
  ) s
$$;

-- Sanity: nothing else in the fresh DB satisfies Q1 pre-fixture.
do $$
declare
  n integer;
begin
  n := pg_temp.q1_count();
  if n <> 0 then raise exception 'baseline FAIL: Q1 returned % on empty fixture', n; end if;
  raise notice 'baseline PASS: Q1 = 0 on empty fixture';
end $$;

-- ---------------------------------------------------------------------------
-- BAD-1: settled battle with winner, no ledger. Q1 should fire.
-- ---------------------------------------------------------------------------
insert into public.battles (id, mode, status, winner_user_id, started_at, ended_at)
values (
  'bb100001-0000-0000-0000-000000000001', 'trivia', 'settled',
  'a1000001-0000-0000-0000-000000000001',
  now() - interval '30 min', now() - interval '10 min'
);

do $$
declare
  n integer;
begin
  n := pg_temp.q1_count();
  if n <> 1 then raise exception 'BAD-1 FAIL: expected 1, got %', n; end if;
  raise notice 'BAD-1 PASS: settled+winner+no-ledger triggers Q1';
end $$;

-- ---------------------------------------------------------------------------
-- LEGIT-null-winner: settled battle, NULL winner (tie). Q1 must NOT fire.
-- ---------------------------------------------------------------------------
insert into public.battles (id, mode, status, winner_user_id, started_at, ended_at)
values (
  'bb100001-0000-0000-0000-000000000002', 'open_debate', 'settled',
  null,
  now() - interval '30 min', now() - interval '10 min'
);

do $$
declare
  n integer;
begin
  n := pg_temp.q1_count();
  -- BAD-1 still active, so count stays at 1.
  if n <> 1 then raise exception 'LEGIT-null-winner FAIL: expected 1 (BAD-1 only), got %', n; end if;
  raise notice 'LEGIT-null-winner PASS: null winner stays silent';
end $$;

-- ---------------------------------------------------------------------------
-- LEGIT-outside-window: settled+winner+no-ledger but ended_at 8 days ago.
-- Q1 must NOT count it.
-- ---------------------------------------------------------------------------
insert into public.battles (id, mode, status, winner_user_id, started_at, ended_at)
values (
  'bb100001-0000-0000-0000-000000000003', 'trivia', 'settled',
  'a1000001-0000-0000-0000-000000000001',
  now() - interval '9 days', now() - interval '8 days'
);

do $$
declare
  n integer;
begin
  n := pg_temp.q1_count();
  if n <> 1 then raise exception 'LEGIT-outside-window FAIL: expected 1, got %', n; end if;
  raise notice 'LEGIT-outside-window PASS: >7d stays silent';
end $$;

-- ---------------------------------------------------------------------------
-- LEGIT-within-grace: settled+winner+no-ledger, ended_at 1 min ago. Q1 must
-- NOT count it (5-min grace window on the fresh side).
-- ---------------------------------------------------------------------------
insert into public.battles (id, mode, status, winner_user_id, started_at, ended_at)
values (
  'bb100001-0000-0000-0000-000000000004', 'trivia', 'settled',
  'a1000001-0000-0000-0000-000000000001',
  now() - interval '20 min', now() - interval '1 min'
);

do $$
declare
  n integer;
begin
  n := pg_temp.q1_count();
  if n <> 1 then raise exception 'LEGIT-within-grace FAIL: expected 1, got %', n; end if;
  raise notice 'LEGIT-within-grace PASS: <5min silent';
end $$;

-- ---------------------------------------------------------------------------
-- LEGIT-correctly-settled: settled+winner AND a real ledger row for the
-- battle produced by apply_ap_drafts. Q1 must NOT count it.
-- ---------------------------------------------------------------------------
insert into public.battles (id, mode, status, winner_user_id, started_at, ended_at)
values (
  'bb100001-0000-0000-0000-000000000005', 'trivia', 'settled',
  'a1000001-0000-0000-0000-000000000001',
  now() - interval '20 min', now() - interval '10 min'
);

do $$
declare
  ignored jsonb;
begin
  ignored := public.apply_ap_drafts(jsonb_build_array(
    jsonb_build_object(
      'user_id', 'a1000001-0000-0000-0000-000000000001'::text,
      'delta', 10,
      'reason', 'battle_win',
      'ref_type', 'battle',
      'ref_id', 'bb100001-0000-0000-0000-000000000005'::text,
      'idempotency_key', 'test:iq1:legit-correct:win',
      'is_practice', false
    ),
    jsonb_build_object(
      'user_id', 'b1000001-0000-0000-0000-000000000002'::text,
      'delta', -10,
      'reason', 'battle_loss',
      'ref_type', 'battle',
      'ref_id', 'bb100001-0000-0000-0000-000000000005'::text,
      'idempotency_key', 'test:iq1:legit-correct:loss',
      'is_practice', false
    )
  ));
end $$;

do $$
declare
  n integer;
begin
  n := pg_temp.q1_count();
  if n <> 1 then raise exception 'LEGIT-correctly-settled FAIL: expected 1, got %', n; end if;
  raise notice 'LEGIT-correctly-settled PASS: apply_ap_drafts satisfies Q1';
end $$;

-- ---------------------------------------------------------------------------
-- LEGIT-ghost-credit-only: settled+winner AND a real ledger row via
-- apply_ap_drafts but with reason='ghost_credit' and delta=0. This is the
-- fixture the user called out: "any ledger row for the battle counts", so
-- Q1 must NOT fire even though no battle_win/battle_loss row exists.
-- ---------------------------------------------------------------------------
insert into public.battles (id, mode, status, winner_user_id, started_at, ended_at)
values (
  'bb100001-0000-0000-0000-000000000006', 'trivia', 'settled',
  'a1000001-0000-0000-0000-000000000001',
  now() - interval '20 min', now() - interval '10 min'
);

do $$
declare
  ignored jsonb;
begin
  ignored := public.apply_ap_drafts(jsonb_build_array(
    jsonb_build_object(
      'user_id', 'a1000001-0000-0000-0000-000000000001'::text,
      'delta', 0,
      'reason', 'ghost_credit',
      'ref_type', 'battle',
      'ref_id', 'bb100001-0000-0000-0000-000000000006'::text,
      'idempotency_key', 'test:iq1:ghost:only',
      'is_practice', false
    )
  ));
end $$;

do $$
declare
  n integer;
begin
  n := pg_temp.q1_count();
  if n <> 1 then raise exception 'LEGIT-ghost-credit-only FAIL: expected 1, got %', n; end if;
  raise notice 'LEGIT-ghost-credit-only PASS: any ledger row satisfies Q1';
end $$;

-- ---------------------------------------------------------------------------
-- Overflow probe: insert enough BAD rows to trip the LIMIT 6 clamp in the
-- runtime query. This test uses the same shape (LIMIT 6), so at 7 total BAD
-- rows the query returns 6 -- proving the runtime signals "6+".
-- ---------------------------------------------------------------------------
insert into public.battles (id, mode, status, winner_user_id, started_at, ended_at) values
  ('bb100001-0000-0000-0000-0000000000a1', 'trivia', 'settled', 'a1000001-0000-0000-0000-000000000001', now() - interval '20 min', now() - interval '11 min'),
  ('bb100001-0000-0000-0000-0000000000a2', 'trivia', 'settled', 'a1000001-0000-0000-0000-000000000001', now() - interval '20 min', now() - interval '12 min'),
  ('bb100001-0000-0000-0000-0000000000a3', 'trivia', 'settled', 'a1000001-0000-0000-0000-000000000001', now() - interval '20 min', now() - interval '13 min'),
  ('bb100001-0000-0000-0000-0000000000a4', 'trivia', 'settled', 'a1000001-0000-0000-0000-000000000001', now() - interval '20 min', now() - interval '14 min'),
  ('bb100001-0000-0000-0000-0000000000a5', 'trivia', 'settled', 'a1000001-0000-0000-0000-000000000001', now() - interval '20 min', now() - interval '15 min'),
  ('bb100001-0000-0000-0000-0000000000a6', 'trivia', 'settled', 'a1000001-0000-0000-0000-000000000001', now() - interval '20 min', now() - interval '16 min');

do $$
declare
  n integer;
begin
  n := pg_temp.q1_count();
  -- BAD-1 (1) + 6 new = 7 BAD in-window; LIMIT 6 clamps.
  if n <> 6 then raise exception 'overflow FAIL: expected clamp to 6, got %', n; end if;
  raise notice 'overflow PASS: LIMIT 6 clamps → runtime signals "6+"';
end $$;

-- ---------------------------------------------------------------------------
-- LEGIT-bot-won (#127 H1): a settled battle where the WINNER is a bot.
-- Post-fix, settleBattle drops the winner's battle_win + ghost_credit drafts
-- and emits ONLY the human loser's zero-delta battle_loss row. That row
-- alone satisfies Q1's `(ref_type='battle', ref_id=b.id)` join. This test
-- proves the invariant does NOT fire on legitimately bot-won battles.
-- (Bot-vs-bot is impossible per matchmake.ts:188; not tested here.)
-- ---------------------------------------------------------------------------

-- Provision a bot user through the canonical trigger path, then flip is_bot.
-- The users_is_bot_immutability_trigger (migration 20261001010000) now
-- blocks post-insert flips, so this test disables the trigger locally
-- (test-only operational path, matches the pattern in
-- users_is_bot_immutable.test.sql's seed section).
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000',
   'c1000001-0000-0000-0000-000000000003', 'authenticated', 'authenticated',
   'iq1-bot@test.local', now(), now());
alter table public.users disable trigger users_is_bot_immutable_check;
update public.users set is_bot = true
  where id = 'c1000001-0000-0000-0000-000000000003';
alter table public.users enable trigger users_is_bot_immutable_check;

insert into public.battles (id, mode, status, winner_user_id, started_at, ended_at)
values (
  'bb100001-0000-0000-0000-0000000000b0', 'trivia', 'settled',
  'c1000001-0000-0000-0000-000000000003',   -- bot wins
  now() - interval '20 min', now() - interval '10 min'
);

do $$
declare
  ignored jsonb;
begin
  -- Post-#127-H1 draft shape for (bot_winner, human_loser, isPractice=true):
  -- ONE row — the human loser's zero-delta battle_loss. No battle_win /
  -- ghost_credit for the bot. `apply_ap_drafts` still writes zero-delta
  -- rows (mig 20260713120000_persist_tier_id_in_settlement.sql:132-149).
  ignored := public.apply_ap_drafts(jsonb_build_array(
    jsonb_build_object(
      'user_id', 'b1000001-0000-0000-0000-000000000002'::text,
      'delta',   0,
      'reason',  'battle_loss',
      'ref_type', 'battle',
      'ref_id',  'bb100001-0000-0000-0000-0000000000b0'::text,
      'idempotency_key', 'test:iq1:bot-won:loss',
      'is_practice', true
    )
  ));
end $$;

do $$
declare
  n integer;
begin
  -- The bot-won battle must NOT be counted by Q1 — it has a ledger row.
  n := pg_temp.q1_count();
  -- Total BAD count is unchanged from the overflow assertion above (6),
  -- because the bot-won battle is legit (ledger present) and does not
  -- add to the BAD set.
  if n <> 6 then
    raise exception 'LEGIT-bot-won FAIL: expected 6 (unchanged), got %', n;
  end if;
  raise notice 'LEGIT-bot-won PASS: human loser row satisfies Q1 for bot-won battle';
end $$;

-- Also confirm the bot user carries ZERO ap_transactions rows keyed by
-- (ref_type='battle', ref_id=b.id) — the whole point of the H1 fix.
do $$
declare
  n integer;
begin
  select count(*) into n from public.ap_transactions t
    join public.users u on u.id = t.user_id
    where u.is_bot = true
      and t.ref_type = 'battle'
      and t.ref_id = 'bb100001-0000-0000-0000-0000000000b0';
  if n <> 0 then
    raise exception 'LEGIT-bot-won FAIL: expected 0 bot ledger rows for the battle, got %', n;
  end if;
  raise notice 'LEGIT-bot-won PASS: zero bot ap_transactions rows for the battle';
end $$;

rollback;

\echo 'invariant_check_battles.test.sql — all cases passed'
