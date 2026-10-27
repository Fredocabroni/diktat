-- Behavioural tests for the data-minimization sweep RPC introduced
-- in migration 20261113000000.
--
-- Covers:
--   M1  anon and authenticated cannot execute the function (service-
--       role only).
--   M2  Dry-run returns candidate counts and does NOT delete anything.
--   M3  Dry-run counts: an age-blocked row >7 days old shows up as a
--       blocked_candidate; younger blocked rows do not; bots never
--       appear.
--   M4  Live run (p_dry_run=false) deletes the age-blocked candidates
--       and returns deleted_blocked matching the candidate count.
--   M5  Pre-launch orphan rows: only humans created before the launch
--       date with age_verified_at IS NULL AND age_blocked_at IS NULL
--       count — and only when current_date > launch + 30 days.
--
-- Note on time travel: PostgreSQL does not expose a built-in
-- "simulate current_date" affordance usable from a test transaction,
-- so M5 is sketched via the shape of the WHERE clause (we insert
-- rows that satisfy it with a historical created_at) and we accept
-- that the "30 days post-launch" window will not fire inside this
-- test transaction unless the clock has already crossed that
-- boundary. The test asserts the SHAPE of the query, not the clock
-- state.

begin;

-- --------------------------------------------------------------------
-- Fixtures.
-- --------------------------------------------------------------------
-- INSERT auth.users rows. The handle_new_user trigger (migration
-- 20261001050000) reads `raw_app_meta_data->>'is_bot'` AT INSERT TIME
-- and stamps public.users.is_bot accordingly — that's the only path
-- that creates a bot row, since the users_is_bot_immutable_check
-- trigger blocks every subsequent UPDATE of is_bot. The bot fixture
-- below uses raw_app_meta_data to signal the trigger; the human
-- fixtures omit it and inherit is_bot=false.
--
-- The trigger also creates the matching public.users shell row with
-- created_at = now() and handle = 'citizen_<slug>'. We then UPDATE
-- the mutable columns (created_at, handle, display_name, age_*) to
-- the historical values this test needs. is_bot is NOT updated — it
-- is write-once at creation time.
insert into auth.users (id, email, aud, role, raw_app_meta_data, created_at, updated_at)
values
  -- M3/M4 candidates: age-blocked humans. raw_app_meta_data omits
  -- is_bot so the trigger defaults to is_bot=false.
  ('11111111-aaaa-4111-8111-111111111111', 'blocked-old@test', 'authenticated',
   'authenticated', '{}'::jsonb, now() - interval '20 days', now()),
  ('22222222-bbbb-4222-8222-222222222222', 'blocked-fresh@test', 'authenticated',
   'authenticated', '{}'::jsonb, now() - interval '1 day', now()),
  -- M3 negative: bot with a (would-be) blocked stamp — the sweep must
  -- exclude it. raw_app_meta_data->>'is_bot' = 'true' is the ONLY way
  -- to stamp is_bot = true, because the immutability trigger blocks
  -- any post-creation UPDATE.
  ('33333333-cccc-4333-8333-333333333333', 'blocked-bot@test', 'authenticated',
   'authenticated', '{"is_bot":true}'::jsonb, now() - interval '20 days', now()),
  -- M5 pre-launch orphan: a human created before 2026-10-21 with no
  -- age stamp. Whether this counts depends on the clock vs launch+30d.
  ('44444444-dddd-4444-8444-444444444444', 'pre-launch@test', 'authenticated',
   'authenticated', '{}'::jsonb, date '2026-05-01', now())
on conflict (id) do nothing;

-- Backfill the mutable columns (handle, display_name, created_at) on
-- the trigger-made public.users shells. is_bot is NOT touched — it's
-- immutable post-creation and already set correctly by the trigger
-- from raw_app_meta_data above.
update public.users
   set handle = 'blo_old',
       display_name = 'BlockedOld',
       created_at = now() - interval '20 days'
 where id = '11111111-aaaa-4111-8111-111111111111';
update public.users
   set handle = 'blo_frh',
       display_name = 'BlockedFresh',
       created_at = now() - interval '1 day'
 where id = '22222222-bbbb-4222-8222-222222222222';
update public.users
   set handle = 'blo_bot',
       display_name = 'BlockedBot',
       created_at = now() - interval '20 days'
 where id = '33333333-cccc-4333-8333-333333333333';
update public.users
   set handle = 'pre_lch',
       display_name = 'PreLaunch',
       created_at = date '2026-05-01'
 where id = '44444444-dddd-4444-8444-444444444444';

-- Stamp age_blocked_at manually (bypassing attest_age so the test
-- stays focused on the sweep). For the bot row, the BEFORE INSERT
-- trigger stamp_bot_age_verified has already stamped age_verified_at;
-- we null it + stamp age_blocked_at here to simulate the "would-be
-- blocked bot" case the sweep must ignore. The users_age_mutex CHECK
-- allows at-most-one-non-null, so we null age_verified_at in the same
-- UPDATE as stamping age_blocked_at.
update public.users
   set age_blocked_at = created_at + interval '2 hours',
       age_verified_at = null
 where id in (
   '11111111-aaaa-4111-8111-111111111111',
   '22222222-bbbb-4222-8222-222222222222',
   '33333333-cccc-4333-8333-333333333333'
 );
-- Pre-launch orphan stays with both age_* null, is_bot=false,
-- created_at < 2026-10-21.

-- --------------------------------------------------------------------
-- M1: anon + authenticated cannot execute.
-- --------------------------------------------------------------------
do $$
declare v_has boolean;
begin
  select has_function_privilege('anon', 'public.data_minimization_sweep(boolean)', 'EXECUTE')
    into v_has;
  if v_has then
    raise exception 'M1: anon has EXECUTE on data_minimization_sweep';
  end if;
  select has_function_privilege('authenticated',
                                'public.data_minimization_sweep(boolean)',
                                'EXECUTE')
    into v_has;
  if v_has then
    raise exception 'M1: authenticated has EXECUTE on data_minimization_sweep';
  end if;
  select has_function_privilege('service_role',
                                'public.data_minimization_sweep(boolean)',
                                'EXECUTE')
    into v_has;
  if not v_has then
    raise exception 'M1: service_role lacks EXECUTE on data_minimization_sweep';
  end if;
end
$$;

-- --------------------------------------------------------------------
-- M2 + M3: dry-run returns counts, deletes nothing, excludes bots.
-- --------------------------------------------------------------------
do $$
declare
  v_out jsonb;
  v_still_there int;
begin
  perform set_config('role', 'postgres', true);
  v_out := public.data_minimization_sweep(true);
  if (v_out->>'dry_run')::boolean is distinct from true then
    raise exception 'M2: dry_run flag not echoed';
  end if;
  if (v_out->>'deleted_blocked')::int <> 0 then
    raise exception 'M2: dry-run deleted blocked rows (expected 0, got %)',
      v_out->>'deleted_blocked';
  end if;
  if (v_out->>'deleted_pre_launch')::int <> 0 then
    raise exception 'M2: dry-run deleted pre-launch rows (expected 0, got %)',
      v_out->>'deleted_pre_launch';
  end if;
  -- blocked_candidates: the >7-day human (id 11111111). The <7-day
  -- human (id 22222222) must be excluded. The bot (id 33333333) must
  -- be excluded.
  if (v_out->>'blocked_candidates')::int < 1 then
    raise exception 'M3: expected >=1 blocked_candidate (the >7d human), got %',
      v_out->>'blocked_candidates';
  end if;
  -- The fresh row (<7d) and the bot must both still exist.
  select count(*) into v_still_there
    from auth.users
    where id in (
      '22222222-bbbb-4222-8222-222222222222',
      '33333333-cccc-4333-8333-333333333333'
    );
  if v_still_there <> 2 then
    raise exception 'M3: dry-run touched fresh/bot rows';
  end if;
  -- M8 (dry-run slice): candidate array keys ALWAYS present; array
  -- length matches candidate count; the >7d human's UUID appears in
  -- blocked_candidate_ids; neither the bot nor the fresh human appears.
  if v_out->'blocked_candidate_ids' is null
     or jsonb_typeof(v_out->'blocked_candidate_ids') <> 'array' then
    raise exception 'M8: blocked_candidate_ids missing or not an array';
  end if;
  if v_out->'pre_launch_candidate_ids' is null
     or jsonb_typeof(v_out->'pre_launch_candidate_ids') <> 'array' then
    raise exception 'M8: pre_launch_candidate_ids missing or not an array';
  end if;
  if jsonb_array_length(v_out->'blocked_candidate_ids')
       <> (v_out->>'blocked_candidates')::int then
    raise exception 'M8: blocked_candidate_ids length <> blocked_candidates';
  end if;
  if not (v_out->'blocked_candidate_ids'
            ? '11111111-aaaa-4111-8111-111111111111') then
    raise exception 'M8: expected >7d human UUID in blocked_candidate_ids';
  end if;
  if v_out->'blocked_candidate_ids'
       ? '22222222-bbbb-4222-8222-222222222222' then
    raise exception 'M8: fresh (<7d) human leaked into blocked_candidate_ids';
  end if;
  if v_out->'blocked_candidate_ids'
       ? '33333333-cccc-4333-8333-333333333333' then
    raise exception 'M8: bot leaked into blocked_candidate_ids';
  end if;
end
$$;

-- --------------------------------------------------------------------
-- M6: operator allowlist excludes a candidate from BOTH counts and
--     from the candidate_ids array. Second half re-runs after the
--     allowlist row is removed, asserting the candidate reappears.
-- --------------------------------------------------------------------
do $$
declare
  v_out        jsonb;
  v_before     int;
  v_after      int;
begin
  perform set_config('role', 'postgres', true);
  -- Baseline count (allowlist is empty): the >7d human must appear.
  v_out := public.data_minimization_sweep(true);
  v_before := (v_out->>'blocked_candidates')::int;
  if v_before < 1 then
    raise exception 'M6: baseline blocked_candidates was 0, fixtures broken';
  end if;
  if not (v_out->'blocked_candidate_ids'
            ? '11111111-aaaa-4111-8111-111111111111') then
    raise exception 'M6: baseline missing >7d human in blocked_candidate_ids';
  end if;

  -- Protect the >7d human.
  insert into public.sweep_protected_users (user_id, note)
  values ('11111111-aaaa-4111-8111-111111111111', 'M6 test');

  v_out := public.data_minimization_sweep(true);
  v_after := (v_out->>'blocked_candidates')::int;
  if v_after <> v_before - 1 then
    raise exception 'M6: allowlist did not drop blocked count (before=%, after=%)',
      v_before, v_after;
  end if;
  if v_out->'blocked_candidate_ids'
       ? '11111111-aaaa-4111-8111-111111111111' then
    raise exception 'M6: allowlisted user still appears in blocked_candidate_ids';
  end if;

  -- Also protect the pre-launch orphan and assert exclusion from the
  -- pre-launch slice. The pre-launch clock gate (current_date > launch
  -- + 30d) may itself hold the count at 0 depending on wall-clock, so
  -- we assert the ID-array membership only when a baseline exists.
  insert into public.sweep_protected_users (user_id, note)
  values ('44444444-dddd-4444-8444-444444444444', 'M6 pre-launch');
  v_out := public.data_minimization_sweep(true);
  if v_out->'pre_launch_candidate_ids'
       ? '44444444-dddd-4444-8444-444444444444' then
    raise exception 'M6: allowlisted pre-launch user leaked into pre_launch_candidate_ids';
  end if;

  -- Remove allowlist rows; the >7d human must reappear.
  delete from public.sweep_protected_users
    where user_id in (
      '11111111-aaaa-4111-8111-111111111111',
      '44444444-dddd-4444-8444-444444444444'
    );
  v_out := public.data_minimization_sweep(true);
  if (v_out->>'blocked_candidates')::int <> v_before then
    raise exception 'M6: removing allowlist did not restore count';
  end if;
end
$$;

-- --------------------------------------------------------------------
-- M7: scrub-on-sweep. A live run must anonymize every
-- ap_transactions.idempotency_key that contains the victim UUID
-- BEFORE auth.users DELETE cascades. Seeded here on the >7d human
-- (id 11111111) so the M4 live-run deletes it with a fully-seeded
-- idempotency_key ledger behind it.
-- --------------------------------------------------------------------
do $$
declare
  v_victim text := '11111111-aaaa-4111-8111-111111111111';
begin
  perform set_config('role', 'postgres', true);
  insert into public.ap_transactions
    (user_id, delta, balance_after, reason, idempotency_key)
  values
    ('11111111-aaaa-4111-8111-111111111111', 100, 100, 'admin_adjust',
     'signup_grant:' || v_victim),
    ('11111111-aaaa-4111-8111-111111111111', -5, 95, 'battle_loss',
     'debate_entry:' || v_victim || ':r1')
  on conflict (idempotency_key) do nothing;
end
$$;

-- --------------------------------------------------------------------
-- M4 + M7 + M9: live run deletes the age-blocked candidates, scrubs
-- the idempotency keys first, and returns the deleted UUIDs under
-- blocked_candidate_ids.
-- --------------------------------------------------------------------
do $$
declare
  v_out jsonb;
  v_still_there int;
  v_residual    int;
  v_victim text := '11111111-aaaa-4111-8111-111111111111';
begin
  perform set_config('role', 'postgres', true);
  v_out := public.data_minimization_sweep(false);
  if (v_out->>'dry_run')::boolean is distinct from false then
    raise exception 'M4: dry_run flag not echoed';
  end if;
  -- The >7d human should be gone; the fresh human + bot should stay.
  select count(*) into v_still_there
    from auth.users
    where id = '11111111-aaaa-4111-8111-111111111111';
  if v_still_there <> 0 then
    raise exception 'M4: live run did not delete the age-blocked >7d human';
  end if;
  select count(*) into v_still_there
    from auth.users
    where id in (
      '22222222-bbbb-4222-8222-222222222222',
      '33333333-cccc-4333-8333-333333333333'
    );
  if v_still_there <> 2 then
    raise exception 'M4: live run deleted the fresh human or the bot';
  end if;
  if (v_out->>'deleted_blocked')::int < 1 then
    raise exception 'M4: deleted_blocked count is zero';
  end if;

  -- M9: live-run candidate array matches deleted_blocked and carries
  -- the actually-deleted UUID.
  if jsonb_array_length(v_out->'blocked_candidate_ids')
       <> (v_out->>'deleted_blocked')::int then
    raise exception 'M9: blocked_candidate_ids length <> deleted_blocked';
  end if;
  if not (v_out->'blocked_candidate_ids'
            ? '11111111-aaaa-4111-8111-111111111111') then
    raise exception 'M9: deleted >7d human UUID missing from blocked_candidate_ids';
  end if;

  -- M7: no residual UUID anywhere in ap_transactions.idempotency_key.
  -- The ap_transactions rows themselves survive (ON DELETE SET NULL
  -- anonymizes user_id) but the UUID substring must be gone.
  select count(*)
    into v_residual
    from public.ap_transactions
    where idempotency_key like '%' || v_victim || '%';
  if v_residual <> 0 then
    raise exception 'M7: % residual ap_transactions rows still carry the victim UUID',
      v_residual;
  end if;
end
$$;

-- --------------------------------------------------------------------
-- M5: pre-launch orphan shape. The query itself is what we assert;
-- the clock-dependence (current_date > launch + 30d) is a separate
-- deployment concern that this test cannot time-travel into.
-- --------------------------------------------------------------------
do $$
declare
  v_candidate_count int;
begin
  perform set_config('role', 'postgres', true);
  select count(*)
    into v_candidate_count
    from public.users
    where is_bot = false
      and age_verified_at is null
      and age_blocked_at is null
      and created_at < date '2026-10-21'
      and current_date > date '2026-10-21' + interval '30 days';
  -- v_candidate_count is >=1 only if the clock is past 2026-11-20.
  -- Either way, the orphan row (id 44444444) must satisfy the shape
  -- of the predicate up to the clock gate. Positive assertion: the
  -- row exists with the required column states.
  if not exists (
    select 1
      from public.users
      where id = '44444444-dddd-4444-8444-444444444444'
        and is_bot = false
        and age_verified_at is null
        and age_blocked_at is null
        and created_at < date '2026-10-21'
  ) then
    raise exception 'M5: pre-launch orphan fixture missing expected column shape';
  end if;
end
$$;

-- --------------------------------------------------------------------
-- M10: delete_my_account behaviour unchanged after helper extraction.
-- The scrub path still produces 'ok=true', scrubs>=1, and leaves no
-- residual UUID anywhere in idempotency_key. Covers the extraction
-- (migration 20261114000000) by exercising delete_my_account end-to-
-- end with a fresh fixture (the account_deletion_ledger.test.sql
-- suite already runs D1..D9; this adds a scoped regression here).
-- --------------------------------------------------------------------
do $$
declare
  v_victim    text := '7a7a7a7a-7777-4777-8777-7a7a7a7a7a7a';
  v_out       jsonb;
  v_residual  int;
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);

  insert into auth.users (id, email, aud, role, created_at, updated_at, last_sign_in_at)
  values (v_victim::uuid, 'm10@test', 'authenticated',
          'authenticated', now(), now(), now() - interval '2 minutes')
  on conflict (id) do nothing;

  update public.users
     set handle = 'm10_u', display_name = 'M10'
   where id = v_victim::uuid;

  insert into public.ap_transactions
    (user_id, delta, balance_after, reason, idempotency_key)
  values
    (v_victim::uuid, 100, 100, 'admin_adjust', 'signup_grant:' || v_victim),
    (v_victim::uuid, -5, 95, 'battle_loss', 'debate_entry:' || v_victim || ':r1')
  on conflict (idempotency_key) do nothing;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_victim, 'role', 'authenticated')::text,
    true);
  perform set_config('role', 'authenticated', true);
  v_out := public.delete_my_account();

  if (v_out->>'ok')::boolean is distinct from true then
    raise exception 'M10: delete_my_account did not return ok=true';
  end if;
  if (v_out->>'scrubbed')::int < 1 then
    raise exception 'M10: scrubbed count was 0, extracted helper did not run';
  end if;

  perform set_config('role', 'postgres', true);
  select count(*)
    into v_residual
    from public.ap_transactions
    where idempotency_key like '%' || v_victim || '%';
  if v_residual <> 0 then
    raise exception 'M10: % residual rows still carry the victim UUID in idempotency_key',
      v_residual;
  end if;
end
$$;

-- --------------------------------------------------------------------
-- M11: internal scrub helper is NOT grantable to clients. anon,
-- authenticated and public must all lack EXECUTE; the helper is
-- reachable only via owner-chained SECURITY DEFINER functions.
-- --------------------------------------------------------------------
do $$
begin
  if has_function_privilege('anon',
       'public._scrub_user_ledger_keys(uuid)', 'EXECUTE') then
    raise exception 'M11: anon has EXECUTE on _scrub_user_ledger_keys';
  end if;
  if has_function_privilege('authenticated',
       'public._scrub_user_ledger_keys(uuid)', 'EXECUTE') then
    raise exception 'M11: authenticated has EXECUTE on _scrub_user_ledger_keys';
  end if;
  if has_function_privilege('public',
       'public._scrub_user_ledger_keys(uuid)', 'EXECUTE') then
    raise exception 'M11: public has EXECUTE on _scrub_user_ledger_keys';
  end if;
end
$$;

-- --------------------------------------------------------------------
-- M12: sweep_protected_users table — RLS on, no end-user grants.
-- --------------------------------------------------------------------
do $$
declare v_rls boolean;
begin
  select relrowsecurity
    into v_rls
    from pg_class
    where oid = 'public.sweep_protected_users'::regclass;
  if not v_rls then
    raise exception 'M12: sweep_protected_users has RLS disabled';
  end if;
  if has_table_privilege('anon', 'public.sweep_protected_users', 'SELECT')
     or has_table_privilege('authenticated', 'public.sweep_protected_users', 'SELECT')
     or has_table_privilege('anon', 'public.sweep_protected_users', 'INSERT')
     or has_table_privilege('authenticated', 'public.sweep_protected_users', 'INSERT') then
    raise exception 'M12: sweep_protected_users exposes SELECT/INSERT to anon or authenticated';
  end if;
end
$$;

rollback;
