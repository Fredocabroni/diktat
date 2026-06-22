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
-- Fixture user creation uses the canonical Supabase pattern: insert into
-- auth.users and let the `handle_new_user()` SECURITY DEFINER trigger
-- (migration 0009) auto-create the public.users / streaks / wallets /
-- ap_transactions rows. The trigger reads only `new.id` and
-- `new.raw_app_meta_data->>'is_bot'` — no JWT or request context required.
-- Earlier attempt used `ALTER TABLE public.users DISABLE TRIGGER ALL` to
-- bypass the FK to auth.users, but that requires the SUPERUSER role
-- attribute (the supabase local `postgres` role does NOT have it; system
-- triggers like RI constraint triggers can only be disabled by a
-- superuser). The auth.users insert path is RLS-bypassed by the postgres
-- role's grants and works cleanly inside a bare begin/rollback.

begin;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

-- Robust, version-tolerant column set: covers the historically-NOT-NULL
-- columns across GoTrue/Supabase auth schema versions. `id` is the only
-- column the trigger needs; the rest defend against schema drift.
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'a1111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'a1@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b2222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'b2@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c3333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated', 'c3@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd4444444-4444-4444-4444-444444444444', 'authenticated', 'authenticated', 'd4@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e5555555-5555-5555-5555-555555555555', 'authenticated', 'authenticated', 'e5@test.local', now(), now());

insert into public.battles (id, mode) values
  ('00000000-0000-0000-0000-0000000000bb', 'open_debate');

insert into public.battle_participants (battle_id, user_id, seat, entry_ap) values
  ('00000000-0000-0000-0000-0000000000bb', 'a1111111-1111-1111-1111-111111111111', 0, 100),
  ('00000000-0000-0000-0000-0000000000bb', 'b2222222-2222-2222-2222-222222222222', 1, 100);

-- ---------------------------------------------------------------------------
-- A1 GREEN: non-participant c3 votes for participant a1 → succeeds.
-- Proves the trigger admits the well-formed case (no false-positives).
-- ---------------------------------------------------------------------------
insert into public.debate_votes (battle_id, voter_user_id, vote_for_user_id, ap_at_vote_time)
values (
  '00000000-0000-0000-0000-0000000000bb',
  'c3333333-3333-3333-3333-333333333333',
  'a1111111-1111-1111-1111-111111111111',
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
    'a1111111-1111-1111-1111-111111111111',
    'b2222222-2222-2222-2222-222222222222',
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
    'd4444444-4444-4444-4444-444444444444',
    'e5555555-5555-5555-5555-555555555555',
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
    'c3333333-3333-3333-3333-333333333333',
    'b2222222-2222-2222-2222-222222222222',
    10
  );
  raise exception 'A4 FAIL: duplicate vote not blocked (expected 23505)';
exception when unique_violation then
  raise notice 'A4 PASS';
end $$;

rollback;
\echo 'ALL ASSERTIONS PASSED'
