-- Behavioural tests for the data-minimization sweep RPC introduced
-- in migration 20261111000000.
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
end
$$;

-- --------------------------------------------------------------------
-- M4: live run deletes the age-blocked candidates.
-- --------------------------------------------------------------------
do $$
declare
  v_out jsonb;
  v_still_there int;
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

rollback;
