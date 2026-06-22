-- Behavioral test: debate_votes participation trigger (migration 20260622141706).
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file
-- Connection is the postgres superuser → RLS BYPASSED. Every blocked insert below
-- therefore proves the BEFORE INSERT trigger enforces the participant invariants
-- at the DB layer, independent of RLS and the tRPC resolver.
--
-- Fixture topology (fixed literal UUIDs; psql :'var' does NOT interpolate inside
-- $$…$$ dollar-quoted bodies, so every statement inlines the UUID):
--   battle bb         : a single open_debate battle row
--   user   a1, b2     : participants (seats 0, 1) in battle bb
--   user   c3, d4     : non-participants (eligible voters)
--   user   e5         : non-participant (used as an INVALID vote target)
--
-- Side-step: public.users.id has an FK to auth.users(id) that the migration set
-- enforces via an internal RI trigger. We `disable trigger all` on public.users
-- for the duration of the fixture insert, then re-enable. This is superuser-
-- scoped, transaction-rolled-back regardless, and does NOT affect the trigger
-- under test (which lives on public.debate_votes, not public.users).

begin;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

alter table public.users disable trigger all;
insert into public.users (id, handle) values
  ('00000000-0000-0000-0000-0000000000a1', 'test_a1_participant'),
  ('00000000-0000-0000-0000-0000000000b2', 'test_b2_participant'),
  ('00000000-0000-0000-0000-0000000000c3', 'test_c3_voter'),
  ('00000000-0000-0000-0000-0000000000d4', 'test_d4_voter'),
  ('00000000-0000-0000-0000-0000000000e5', 'test_e5_outsider');
alter table public.users enable trigger all;

insert into public.battles (id, mode) values
  ('00000000-0000-0000-0000-0000000000bb', 'open_debate');

insert into public.battle_participants (battle_id, user_id, seat, entry_ap) values
  ('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-0000000000a1', 0, 100),
  ('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-0000000000b2', 1, 100);

-- ---------------------------------------------------------------------------
-- A1 GREEN: non-participant c3 votes for participant a1 → succeeds.
-- Proves the trigger admits the well-formed case (no false-positives).
-- ---------------------------------------------------------------------------
insert into public.debate_votes (battle_id, voter_user_id, vote_for_user_id, ap_at_vote_time)
values (
  '00000000-0000-0000-0000-0000000000bb',
  '00000000-0000-0000-0000-0000000000c3',
  '00000000-0000-0000-0000-0000000000a1',
  10
);
\echo 'A1 PASS'

-- ---------------------------------------------------------------------------
-- A2 RED DK001: participant a1 tries to vote → trigger blocks.
-- Proves invariant 1 (exclusion) is enforced at the DB layer.
-- ---------------------------------------------------------------------------
do $$
begin
  insert into public.debate_votes (battle_id, voter_user_id, vote_for_user_id, ap_at_vote_time)
  values (
    '00000000-0000-0000-0000-0000000000bb',
    '00000000-0000-0000-0000-0000000000a1',
    '00000000-0000-0000-0000-0000000000b2',
    10
  );
  raise exception 'A2 FAIL: participant voter not blocked (expected DK001)';
exception when sqlstate 'DK001' then
  raise notice 'A2 PASS';
end $$;

-- ---------------------------------------------------------------------------
-- A3 RED DK002: non-participant target e5 → trigger blocks.
-- Proves invariant 2 (inclusion) is enforced at the DB layer.
-- ---------------------------------------------------------------------------
do $$
begin
  insert into public.debate_votes (battle_id, voter_user_id, vote_for_user_id, ap_at_vote_time)
  values (
    '00000000-0000-0000-0000-0000000000bb',
    '00000000-0000-0000-0000-0000000000d4',
    '00000000-0000-0000-0000-0000000000e5',
    10
  );
  raise exception 'A3 FAIL: non-participant target not blocked (expected DK002)';
exception when sqlstate 'DK002' then
  raise notice 'A3 PASS';
end $$;

-- ---------------------------------------------------------------------------
-- A4 REGRESSION: c3 already voted in A1; a SECOND valid vote (different
-- target) must hit the pre-existing unique (battle_id, voter_user_id)
-- constraint with sqlstate 23505. Proves the trigger PASSES valid rows
-- through to the unique constraint rather than shadowing it.
-- ---------------------------------------------------------------------------
do $$
begin
  insert into public.debate_votes (battle_id, voter_user_id, vote_for_user_id, ap_at_vote_time)
  values (
    '00000000-0000-0000-0000-0000000000bb',
    '00000000-0000-0000-0000-0000000000c3',
    '00000000-0000-0000-0000-0000000000b2',
    10
  );
  raise exception 'A4 FAIL: duplicate vote not blocked (expected 23505)';
exception when unique_violation then
  raise notice 'A4 PASS';
end $$;

rollback;
\echo 'ALL ASSERTIONS PASSED'
