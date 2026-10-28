-- Behavioural tests for migration 20261115000000: age-block tombstone
-- table + Before-User-Created auth hook.
--
-- Covers:
--   T1  Tombstone written on live age-blocked sweep (one row per
--       victim email, hash matches encode(sha256(lower(btrim(email))),
--       'hex')).
--   T2  Tombstone NOT written on dry-run (same fixture, counts only).
--   T3  Tombstone NOT written on pre-launch branch (fixture satisfies
--       the pre-launch WHERE shape; even if the clock gate fires and
--       deletes the row, no tombstone is produced).
--   T4  Hash normalization: whitespace- and case-insensitive.
--   T5  Hook rejects a tombstoned, non-expired email with http_code 403.
--   T6  Hook allows a non-tombstoned email ({} envelope).
--   T7  Hook allows an expired tombstone (expires_at <= now()).
--   T8  Daily cleanup: expired tombstones get deleted on every sweep
--       tick (dry-run included); tombstones_expired counter >= 1.
--   T9  Grants / RLS posture:
--         - age_block_tombstones: RLS on; anon/authenticated have no
--           SELECT or INSERT.
--         - hook_before_user_created: anon/authenticated/public lack
--           EXECUTE; supabase_auth_admin has EXECUTE.
--
-- The 'postgres' owner role (used in the perform set_config lines
-- below) has BYPASSRLS on this project — the same affordance
-- data_minimization_sweep.test.sql relies on.

begin;

-- --------------------------------------------------------------------
-- Fixtures.
-- --------------------------------------------------------------------
-- Three humans + one bot, mirroring the data_minimization_sweep test
-- but with a known plaintext email on the age-blocked human so we can
-- recompute the expected hash in-test.
--
-- The handle_new_user trigger (migration 20261001050000) reads
-- raw_app_meta_data->>'is_bot' at insert time. is_bot is write-once
-- (immutable trigger). Age columns get stamped via UPDATE below.
insert into auth.users (id, email, aud, role, raw_app_meta_data, created_at, updated_at)
values
  -- T1/T4/T8 subject: age-blocked human with a predictable email.
  ('a1a1a1a1-0001-4001-8001-a1a1a1a1a1a1', 'Victim.T1@Example.COM',
   'authenticated', 'authenticated', '{}'::jsonb,
   now() - interval '20 days', now()),
  -- T2 subject: distinct user, used to assert dry-run writes nothing.
  ('b2b2b2b2-0002-4002-8002-b2b2b2b2b2b2', 'victim.t2@example.com',
   'authenticated', 'authenticated', '{}'::jsonb,
   now() - interval '20 days', now()),
  -- T3 pre-launch orphan: no age stamps, created pre-launch.
  ('c3c3c3c3-0003-4003-8003-c3c3c3c3c3c3', 'prelaunch.t3@example.com',
   'authenticated', 'authenticated', '{}'::jsonb,
   date '2026-05-01', now())
on conflict (id) do nothing;

update public.users
   set handle = 'v_t1', display_name = 'VictimT1',
       created_at = now() - interval '20 days'
 where id = 'a1a1a1a1-0001-4001-8001-a1a1a1a1a1a1';
update public.users
   set handle = 'v_t2', display_name = 'VictimT2',
       created_at = now() - interval '20 days'
 where id = 'b2b2b2b2-0002-4002-8002-b2b2b2b2b2b2';
update public.users
   set handle = 'v_t3', display_name = 'PreLaunchT3',
       created_at = date '2026-05-01'
 where id = 'c3c3c3c3-0003-4003-8003-c3c3c3c3c3c3';

-- Stamp age_blocked_at on the two age-blocked humans. Pre-launch
-- orphan stays with both age_* null.
update public.users
   set age_blocked_at = created_at + interval '2 hours',
       age_verified_at = null
 where id in (
   'a1a1a1a1-0001-4001-8001-a1a1a1a1a1a1',
   'b2b2b2b2-0002-4002-8002-b2b2b2b2b2b2'
 );

-- --------------------------------------------------------------------
-- T2: dry-run writes no tombstones even with eligible victims.
-- --------------------------------------------------------------------
do $$
declare
  v_out    jsonb;
  v_count  int;
begin
  perform set_config('role', 'postgres', true);
  v_out := public.data_minimization_sweep(true);
  if (v_out->>'tombstones_written')::int <> 0 then
    raise exception 'T2: dry-run wrote % tombstones (expected 0)',
      v_out->>'tombstones_written';
  end if;
  select count(*) into v_count from public.age_block_tombstones;
  if v_count <> 0 then
    raise exception 'T2: dry-run left % rows in age_block_tombstones',
      v_count;
  end if;
end
$$;

-- --------------------------------------------------------------------
-- T4 (part 1): hash normalization matches the migration formula.
-- Precompute the expected hash for 'Victim.T1@Example.COM' and the
-- same string lower+trimmed; they must be equal.
-- --------------------------------------------------------------------
do $$
declare
  v_raw      text := '  Victim.T1@Example.COM  ';
  v_canon    text := 'victim.t1@example.com';
  v_h_raw    text;
  v_h_canon  text;
begin
  v_h_raw := encode(pg_catalog.sha256(lower(btrim(v_raw))::bytea), 'hex');
  v_h_canon := encode(pg_catalog.sha256(v_canon::bytea), 'hex');
  if v_h_raw <> v_h_canon then
    raise exception 'T4: hash normalization mismatch (raw=%, canon=%)',
      v_h_raw, v_h_canon;
  end if;
end
$$;

-- --------------------------------------------------------------------
-- T1: live sweep writes a tombstone with the expected hash and the
-- age-blocked human is deleted. Also seeds the pre-launch orphan
-- fixture for T3 to assert below.
-- --------------------------------------------------------------------
do $$
declare
  v_out            jsonb;
  v_expected_hash  text;
  v_tombstone_cnt  int;
  v_still_there    int;
begin
  perform set_config('role', 'postgres', true);

  -- Normalized hash for the T1 victim's email as auth.users stored it
  -- ('Victim.T1@Example.COM' — the migration lower+btrims before
  -- hashing).
  v_expected_hash := encode(
    pg_catalog.sha256(lower(btrim('Victim.T1@Example.COM'))::bytea),
    'hex'
  );

  v_out := public.data_minimization_sweep(false);

  if (v_out->>'tombstones_written')::int < 2 then
    raise exception 'T1: expected >=2 tombstones_written on live sweep, got %',
      v_out->>'tombstones_written';
  end if;

  -- Row with the T1 victim's hash must exist with a future expires_at.
  select count(*)
    into v_tombstone_cnt
    from public.age_block_tombstones
    where email_hash = v_expected_hash
      and expires_at > now();
  if v_tombstone_cnt <> 1 then
    raise exception 'T1: expected 1 tombstone for v_t1 hash, got %',
      v_tombstone_cnt;
  end if;

  -- The age-blocked human must be gone from auth.users.
  select count(*)
    into v_still_there
    from auth.users
    where id = 'a1a1a1a1-0001-4001-8001-a1a1a1a1a1a1';
  if v_still_there <> 0 then
    raise exception 'T1: live sweep did not delete the age-blocked human';
  end if;

  -- The pre-launch orphan must still be present unless the clock has
  -- crossed launch+30d (and even then, no tombstone was written). We
  -- assert no tombstone row exists for its email hash regardless.
  if exists (
    select 1 from public.age_block_tombstones
    where email_hash = encode(
      pg_catalog.sha256(lower(btrim('prelaunch.t3@example.com'))::bytea),
      'hex'
    )
  ) then
    raise exception 'T3: pre-launch orphan leaked into age_block_tombstones';
  end if;
end
$$;

-- --------------------------------------------------------------------
-- T5: hook rejects a tombstoned email with the documented
-- {error:{message,http_code=403}} envelope.
-- --------------------------------------------------------------------
do $$
declare
  v_out jsonb;
begin
  perform set_config('role', 'postgres', true);
  v_out := public.hook_before_user_created(
    jsonb_build_object(
      'metadata', jsonb_build_object(
        'name', 'before-user-created',
        'ip_address', '127.0.0.1'
      ),
      'user', jsonb_build_object(
        'email', 'victim.t1@example.com'
      )
    )
  );
  if v_out->'error' is null then
    raise exception 'T5: hook did not reject tombstoned email, got %', v_out::text;
  end if;
  if (v_out->'error'->>'http_code')::int <> 403 then
    raise exception 'T5: expected http_code=403, got %',
      v_out->'error'->>'http_code';
  end if;
end
$$;

-- --------------------------------------------------------------------
-- T4 (part 2): hook is case/whitespace insensitive — the same victim
-- email formatted differently still rejects.
-- --------------------------------------------------------------------
do $$
declare
  v_out jsonb;
begin
  perform set_config('role', 'postgres', true);
  v_out := public.hook_before_user_created(
    jsonb_build_object(
      'user', jsonb_build_object('email', '  VICTIM.T1@EXAMPLE.com  ')
    )
  );
  if v_out->'error' is null
     or (v_out->'error'->>'http_code')::int <> 403 then
    raise exception 'T4: case/whitespace-variant email not rejected, got %',
      v_out::text;
  end if;
end
$$;

-- --------------------------------------------------------------------
-- T6: hook allows a non-tombstoned email ({} envelope).
-- --------------------------------------------------------------------
do $$
declare
  v_out jsonb;
begin
  perform set_config('role', 'postgres', true);
  v_out := public.hook_before_user_created(
    jsonb_build_object(
      'user', jsonb_build_object('email', 'never.blocked@example.com')
    )
  );
  if v_out <> '{}'::jsonb then
    raise exception 'T6: expected {} for non-tombstoned email, got %',
      v_out::text;
  end if;
end
$$;

-- --------------------------------------------------------------------
-- T7: an expired tombstone (expires_at <= now()) allows signup. Set
-- the row we wrote in T1 to expired and re-check.
-- --------------------------------------------------------------------
do $$
declare
  v_out jsonb;
begin
  perform set_config('role', 'postgres', true);
  update public.age_block_tombstones
     set expires_at = now() - interval '1 second'
   where email_hash = encode(
     pg_catalog.sha256(lower(btrim('victim.t1@example.com'))::bytea),
     'hex'
   );
  v_out := public.hook_before_user_created(
    jsonb_build_object(
      'user', jsonb_build_object('email', 'victim.t1@example.com')
    )
  );
  if v_out <> '{}'::jsonb then
    raise exception 'T7: expired tombstone still rejected, got %', v_out::text;
  end if;
end
$$;

-- --------------------------------------------------------------------
-- T8: daily cleanup. The expired row from T7 must be removed on the
-- next sweep tick (dry-run suffices because cleanup runs regardless of
-- dry-run). tombstones_expired counter >= 1.
-- --------------------------------------------------------------------
do $$
declare
  v_out            jsonb;
  v_still_there    int;
  v_expected_hash  text := encode(
    pg_catalog.sha256(lower(btrim('victim.t1@example.com'))::bytea),
    'hex'
  );
begin
  perform set_config('role', 'postgres', true);
  v_out := public.data_minimization_sweep(true);
  if (v_out->>'tombstones_expired')::int < 1 then
    raise exception 'T8: expected tombstones_expired >= 1, got %',
      v_out->>'tombstones_expired';
  end if;
  select count(*)
    into v_still_there
    from public.age_block_tombstones
    where email_hash = v_expected_hash;
  if v_still_there <> 0 then
    raise exception 'T8: expired tombstone not deleted (count=%)',
      v_still_there;
  end if;
end
$$;

-- --------------------------------------------------------------------
-- T9: grants / RLS posture.
-- --------------------------------------------------------------------
do $$
declare
  v_rls boolean;
begin
  -- Table: RLS on, no SELECT/INSERT for anon or authenticated.
  select relrowsecurity
    into v_rls
    from pg_class
    where oid = 'public.age_block_tombstones'::regclass;
  if not v_rls then
    raise exception 'T9: age_block_tombstones has RLS disabled';
  end if;
  if has_table_privilege('anon', 'public.age_block_tombstones', 'SELECT')
     or has_table_privilege('authenticated', 'public.age_block_tombstones', 'SELECT')
     or has_table_privilege('anon', 'public.age_block_tombstones', 'INSERT')
     or has_table_privilege('authenticated', 'public.age_block_tombstones', 'INSERT') then
    raise exception 'T9: age_block_tombstones exposes SELECT/INSERT to anon/authenticated';
  end if;

  -- Hook: no execute for anon/authenticated/public; supabase_auth_admin
  -- must have EXECUTE.
  if has_function_privilege('anon',
       'public.hook_before_user_created(jsonb)', 'EXECUTE') then
    raise exception 'T9: anon has EXECUTE on hook_before_user_created';
  end if;
  if has_function_privilege('authenticated',
       'public.hook_before_user_created(jsonb)', 'EXECUTE') then
    raise exception 'T9: authenticated has EXECUTE on hook_before_user_created';
  end if;
  if has_function_privilege('public',
       'public.hook_before_user_created(jsonb)', 'EXECUTE') then
    raise exception 'T9: public has EXECUTE on hook_before_user_created';
  end if;
  if not has_function_privilege('supabase_auth_admin',
       'public.hook_before_user_created(jsonb)', 'EXECUTE') then
    raise exception 'T9: supabase_auth_admin lacks EXECUTE on hook_before_user_created';
  end if;
end
$$;

rollback;
