-- RLS behavioral test: battle_participants (bp_select_self, bp_insert_self,
-- battle_participants_select_open_debate_observers). Phase 1 seeds as
-- postgres (RLS bypassed); Phase 2 runs as role=authenticated, simulating
-- each user via `request.jwt.claims.sub` (what `auth.uid()` / `public.is_self()`
-- read). RLS is enforced for every Phase-2 statement.
--
-- Fixture topology (UUIDs are fixed literals; psql :'var' does NOT
-- interpolate inside $$…$$ dollar-quoted bodies, so every statement
-- inlines the UUID):
--
--   battles:
--     B_obs     bb000001-…-001  mode=open_debate, status=live   → observer policy ADMITS
--     B_queued  bb000002-…-002  mode=open_debate, status=queued → status boundary; observer NOT admit
--     B_nonmode bb000003-…-003  mode=trivia,      status=live   → mode boundary;   observer NOT admit
--
--   users (same UUIDs + handle-derivation shape as PR #72; first 10 hex
--   chars distinct so handle_new_user() does not collide):
--     a1  participant (seat 0) in all three battles
--     b2  participant (seat 1) in all three battles
--     c3  non-participant; used as the observer-perspective persona
--     d4  non-participant; used for the bp_insert_self self-insert (A6)
--     e5  non-participant; used as the target of d4's cross-user insert (A7)
--
-- The handle_new_user() trigger on auth.users INSERT auto-creates the
-- public.users / streaks / wallets / ap_transactions rows (see PR #72
-- commit message for the chain audit). The trigger runs as SECURITY
-- DEFINER and reads only `new.id` + `new.raw_app_meta_data->>'is_bot'` —
-- no JWT or request context required.

begin;

-- ---------------------------------------------------------------------------
-- Phase 1: fixtures as postgres (RLS bypassed via postgres' table-owner +
-- bypassrls posture). Every public.battles + battle_participants row is
-- visible to the seeder regardless of policy.
-- ---------------------------------------------------------------------------

-- Five users via the auth.users → handle_new_user() trigger chain.
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'a1111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'a1@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b2222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'b2@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c3333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated', 'c3@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd4444444-4444-4444-4444-444444444444', 'authenticated', 'authenticated', 'd4@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e5555555-5555-5555-5555-555555555555', 'authenticated', 'authenticated', 'e5@test.local', now(), now());

-- Three battles spanning the observer-policy boundary surface:
--   B_obs     : the happy-path observer case (mode=open_debate, status=live).
--   B_queued  : same mode, status boundary (queued is NOT in ('live','settled')).
--   B_nonmode : same status, mode boundary (trivia is NOT 'open_debate').
insert into public.battles (id, mode, status) values
  ('bb000001-0000-0000-0000-000000000001', 'open_debate', 'live'),
  ('bb000002-0000-0000-0000-000000000002', 'open_debate', 'queued'),
  ('bb000003-0000-0000-0000-000000000003', 'trivia',      'live');

-- a1 + b2 are participants in EVERY battle. The observer-policy delta is
-- the BATTLE attributes, not the seat assignment, so identical participant
-- sets across all three isolate the policy semantics from any per-battle
-- variation.
insert into public.battle_participants (battle_id, user_id, seat, entry_ap) values
  ('bb000001-0000-0000-0000-000000000001', 'a1111111-1111-1111-1111-111111111111', 0, 100),
  ('bb000001-0000-0000-0000-000000000001', 'b2222222-2222-2222-2222-222222222222', 1, 100),
  ('bb000002-0000-0000-0000-000000000002', 'a1111111-1111-1111-1111-111111111111', 0, 100),
  ('bb000002-0000-0000-0000-000000000002', 'b2222222-2222-2222-2222-222222222222', 1, 100),
  ('bb000003-0000-0000-0000-000000000003', 'a1111111-1111-1111-1111-111111111111', 0, 100),
  ('bb000003-0000-0000-0000-000000000003', 'b2222222-2222-2222-2222-222222222222', 1, 100);

-- ---------------------------------------------------------------------------
-- Phase 2: persona-switched assertions under role=authenticated.
-- `set local` is transaction-scoped and reverts at COMMIT/ROLLBACK. Each
-- `set local request.jwt.claims` replaces the previous claim blob; no need
-- to RESET between personas. `auth.uid()` reads ->>'sub' off this blob.
-- ---------------------------------------------------------------------------

set local role authenticated;

-- ===========================================================================
-- Persona a1 (participant in all three battles)
-- ===========================================================================
set local request.jwt.claims = '{"sub":"a1111111-1111-1111-1111-111111111111","role":"authenticated"}';

-- A1: a1 sees its own row in B_queued (observer policy does NOT admit at
-- status=queued, so the only admitting policy is bp_select_self).
do $$
declare n int;
begin
  select count(*) into n from public.battle_participants
    where battle_id = 'bb000002-0000-0000-0000-000000000002'
      and user_id   = 'a1111111-1111-1111-1111-111111111111';
  if n <> 1 then raise exception 'A1 FAIL: own row not visible in B_queued, got %', n; end if;
  raise notice 'A1 PASS';
end $$;

-- A2: a1 does NOT see b2's row in B_queued (no observer admission; not own).
do $$
declare n int;
begin
  select count(*) into n from public.battle_participants
    where battle_id = 'bb000002-0000-0000-0000-000000000002'
      and user_id   = 'b2222222-2222-2222-2222-222222222222';
  if n <> 0 then raise exception 'A2 FAIL: other row leaked in B_queued, got %', n; end if;
  raise notice 'A2 PASS';
end $$;

-- ===========================================================================
-- Persona c3 (non-participant — observer perspective)
-- ===========================================================================
set local request.jwt.claims = '{"sub":"c3333333-3333-3333-3333-333333333333","role":"authenticated"}';

-- A3 (bypass-mechanics proof): the SECURITY DEFINER helper
-- `public.is_battle_open_debate_observable(uuid)` (migration 20260622164814)
-- MUST read public.battles with RLS bypassed. If owner-bypass does NOT hold
-- in this environment (e.g. a future migration adds FORCE ROW LEVEL
-- SECURITY to battles without updating the helper), this call re-enters
-- battles' policies → battle_participants' policies → 42P17, and reds HERE
-- in isolation rather than ambiguously inside A4. Proves the fix's
-- mechanism, not just its effect. Runs as `role=authenticated` (NOT
-- postgres), so it exercises the exact DEFINER-bypass path the observer
-- policy depends on at every authenticated query.
do $$
declare v boolean;
begin
  select public.is_battle_open_debate_observable('bb000001-0000-0000-0000-000000000001') into v;
  if v is not true then
    raise exception 'A3 FAIL: helper returned % for live open_debate battle (expected true) — owner-bypass premise broken', v;
  end if;
  raise notice 'A3 PASS';
end $$;

-- A4: c3 sees BOTH participant rows in B_obs via the observer policy
-- (mode=open_debate AND status=live → admits).
do $$
declare n int;
begin
  select count(*) into n from public.battle_participants
    where battle_id = 'bb000001-0000-0000-0000-000000000001';
  if n <> 2 then raise exception 'A4 FAIL: observer expected 2 rows in B_obs, got %', n; end if;
  raise notice 'A4 PASS';
end $$;

-- A5: c3 sees NOTHING in B_queued (open_debate but status=queued — status
-- boundary; observer policy does NOT admit; c3 is not a participant).
do $$
declare n int;
begin
  select count(*) into n from public.battle_participants
    where battle_id = 'bb000002-0000-0000-0000-000000000002';
  if n <> 0 then raise exception 'A5 FAIL: status boundary leaked in B_queued, got %', n; end if;
  raise notice 'A5 PASS';
end $$;

-- A6: c3 sees NOTHING in B_nonmode (trivia + live — mode boundary; observer
-- policy does NOT admit; c3 is not a participant).
do $$
declare n int;
begin
  select count(*) into n from public.battle_participants
    where battle_id = 'bb000003-0000-0000-0000-000000000003';
  if n <> 0 then raise exception 'A6 FAIL: mode boundary leaked in B_nonmode, got %', n; end if;
  raise notice 'A6 PASS';
end $$;

-- ===========================================================================
-- Persona d4 (insert paths)
-- ===========================================================================
set local request.jwt.claims = '{"sub":"d4444444-4444-4444-4444-444444444444","role":"authenticated"}';

-- A7: d4 inserts ITSELF into B_queued (self-join). `bp_insert_self`
-- with check (is_self(user_id)) admits.
insert into public.battle_participants (battle_id, user_id, seat, entry_ap)
  values ('bb000002-0000-0000-0000-000000000002', 'd4444444-4444-4444-4444-444444444444', 2, 100);
\echo 'A7 PASS'

-- A8: d4 tries to insert e5 (cross-user). `bp_insert_self`'s with-check
-- denies; PG raises 42501 (insufficient_privilege — the RLS-policy
-- violation sqlstate for INSERT/UPDATE).
do $$
begin
  insert into public.battle_participants (battle_id, user_id, seat, entry_ap)
    values ('bb000002-0000-0000-0000-000000000002', 'e5555555-5555-5555-5555-555555555555', 3, 100);
  raise exception 'A8 FAIL: cross-user insert not blocked (expected 42501)';
exception when sqlstate '42501' then
  raise notice 'A8 PASS';
end $$;

rollback;
\echo 'ALL RLS ASSERTIONS PASSED (A1-A8)'
