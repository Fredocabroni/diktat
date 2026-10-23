-- Behavioural tests for the 18+ age-gate RPC (migration 20261108000000).
-- Covers:
--   T1  Null auth → 28000.
--   T2  Birth date in the future → 22023.
--   T3  Birth date before 1900 → 22023.
--   T4  18+ → verified; age_verified_at set, age_blocked_at null.
--   T5  <18 → blocked; age_blocked_at set, age_verified_at null.
--   T6  Attest from a blocked account refuses with P0001, even with
--       a 100%-adult DOB. "no hints about lying".
--   T7  Already-verified row → idempotent 'already_verified' outcome,
--       no stamp drift.
--   T8  CHECK users_age_mutex rejects a direct SQL insert that tries
--       to set both age_verified_at AND age_blocked_at.
--   T9  Backfill: existing bot rows carry age_verified_at IS NOT NULL.
--   T10 BEFORE INSERT trigger: a new bot inserted directly has
--       age_verified_at stamped automatically.
--   T11 get_user_self() returns the two new columns.
--   T12 attest_age is NOT reachable by `anon` (revoke all from anon;
--       grant execute only to authenticated/service_role).

begin;

-- Fixtures. Two fresh users keyed off auth.uid() via SET LOCAL below.
insert into auth.users (id, email, aud, role, created_at, updated_at)
values
  ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'adult@test', 'authenticated',
   'authenticated', now(), now()),
  ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'minor@test', 'authenticated',
   'authenticated', now(), now()),
  ('cccccccc-3333-4333-8333-cccccccccccc', 'retry@test', 'authenticated',
   'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.users (id, handle, display_name)
values
  ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'adult_t', 'Adult'),
  ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'minor_t', 'Minor'),
  ('cccccccc-3333-4333-8333-cccccccccccc', 'retry_t', 'Retry')
on conflict (id) do nothing;

-- Helper: set the local request to look authenticated for a given user.
create or replace function _test_as(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid::text, 'role', 'authenticated')::text,
    true);
  perform set_config('role', 'authenticated', true);
end
$$;

-- T1: null auth → 28000.
do $$
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.attest_age(date '2000-01-01', true);
    raise exception 'T1: expected 28000, got no error';
  exception when sqlstate '28000' then
    null; -- expected
  end;
end
$$;

-- T2: future birth date → 22023.
do $$
begin
  perform _test_as('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
  begin
    perform public.attest_age((current_date + interval '1 day')::date, true);
    raise exception 'T2: expected 22023 (future DOB)';
  exception when sqlstate '22023' then
    null;
  end;
end
$$;

-- T3: too-old birth date → 22023.
do $$
begin
  perform _test_as('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
  begin
    perform public.attest_age(date '1899-12-31', true);
    raise exception 'T3: expected 22023 (DOB before 1900)';
  exception when sqlstate '22023' then
    null;
  end;
end
$$;

-- T4: 18+ → verified. Verification SELECT switches back to postgres
-- because the `authenticated` column-grant subset (migration
-- 20260618120000) excludes the two new timestamptz columns — `select *`
-- as authenticated would fail with "permission denied for table users"
-- (the local test rig uses `role=postgres` by default; running against
-- CI's postgres superuser is why we flip back here).
do $$
declare
  v_out jsonb;
  v_row public.users%rowtype;
begin
  perform _test_as('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
  v_out := public.attest_age((current_date - interval '30 years')::date, true);
  if v_out->>'outcome' <> 'verified' then
    raise exception 'T4: expected outcome=verified, got %', v_out;
  end if;
  perform set_config('role', 'postgres', true);
  select * into v_row from public.users
   where id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  if v_row.age_verified_at is null then
    raise exception 'T4: age_verified_at not stamped';
  end if;
  if v_row.age_blocked_at is not null then
    raise exception 'T4: age_blocked_at should still be null';
  end if;
end
$$;

-- T5: <18 → blocked.
do $$
declare
  v_out jsonb;
  v_row public.users%rowtype;
begin
  perform _test_as('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb');
  v_out := public.attest_age((current_date - interval '10 years')::date, true);
  if v_out->>'outcome' <> 'blocked' then
    raise exception 'T5: expected outcome=blocked, got %', v_out;
  end if;
  perform set_config('role', 'postgres', true);
  select * into v_row from public.users
   where id = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  if v_row.age_blocked_at is null then
    raise exception 'T5: age_blocked_at not stamped';
  end if;
  if v_row.age_verified_at is not null then
    raise exception 'T5: age_verified_at should be null';
  end if;
end
$$;

-- T6: blocked account refuses further attempts with P0001.
do $$
begin
  perform _test_as('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb');
  begin
    perform public.attest_age((current_date - interval '40 years')::date, true);
    raise exception 'T6: expected P0001 (no further attempts)';
  exception when sqlstate 'P0001' then
    null;
  end;
end
$$;

-- T7: already-verified → idempotent. Verification SELECTs run as
-- postgres (see T4 note).
do $$
declare
  v_out jsonb;
  v_before_at timestamptz;
  v_after_at  timestamptz;
begin
  perform set_config('role', 'postgres', true);
  select age_verified_at into v_before_at from public.users
   where id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  perform _test_as('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
  v_out := public.attest_age((current_date - interval '25 years')::date, true);
  if v_out->>'outcome' <> 'already_verified' then
    raise exception 'T7: expected outcome=already_verified, got %', v_out;
  end if;
  perform set_config('role', 'postgres', true);
  select age_verified_at into v_after_at from public.users
   where id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  if v_after_at <> v_before_at then
    raise exception 'T7: age_verified_at drifted on idempotent call';
  end if;
end
$$;

-- T8: direct SQL insert with both columns → CHECK violation.
do $$
begin
  perform set_config('role', 'postgres', true);
  begin
    insert into public.users (id, handle, display_name,
                              age_verified_at, age_blocked_at)
    values ('dddddddd-4444-4444-8444-dddddddddddd', 'both_t', 'Both',
            now(), now());
    raise exception 'T8: expected CHECK violation on users_age_mutex';
  exception when check_violation then
    null;
  end;
end
$$;

-- T9: existing bots carry age_verified_at (backfill).
do $$
declare
  v_count int;
begin
  select count(*)::int into v_count
    from public.users
   where is_bot = true
     and age_verified_at is null;
  if v_count <> 0 then
    raise exception 'T9: % bot rows missing age_verified_at after backfill', v_count;
  end if;
end
$$;

-- T10: a direct bot-flagged public.users INSERT fires the BEFORE INSERT
-- trigger (`stamp_bot_age_verified_trigger`). We flip an existing row
-- to is_bot via a fresh INSERT after wiping the handle_new_user shell:
-- the auth.users FK requires its matching auth row to exist, so we
-- stage a fresh auth.users row, let handle_new_user create its public
-- shell (which the BEFORE INSERT trigger runs against), then flip the
-- shell to is_bot — the second part exercises the trigger NOT, so we
-- re-insert from scratch via DELETE + INSERT to force the trigger path.
do $$
declare
  v_row public.users%rowtype;
begin
  perform set_config('role', 'postgres', true);
  insert into auth.users (id, email, aud, role, created_at, updated_at)
  values ('eeeeeeee-5555-4555-8555-eeeeeeeeeeee', 'bot5@test',
          'authenticated', 'authenticated', now(), now())
  on conflict (id) do nothing;

  -- handle_new_user has created the shell row by now. Delete + re-
  -- insert directly so the stamp_bot_age_verified_trigger fires on
  -- the new row with is_bot=true.
  delete from public.users where id = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
  insert into public.users (id, handle, display_name, is_bot)
  values ('eeeeeeee-5555-4555-8555-eeeeeeeeeeee', 'bot5_t', 'Bot5', true);

  select * into v_row from public.users
   where id = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
  if v_row.age_verified_at is null then
    raise exception 'T10: new bot missing age_verified_at — trigger did not stamp';
  end if;
end
$$;

-- T11: get_user_self() returns the two new columns.
do $$
declare
  v jsonb;
  v_count int;
begin
  perform _test_as('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
  -- Shape pin: the function returns a table with the two columns.
  select count(*)::int into v_count
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'users'
     and column_name in ('age_verified_at', 'age_blocked_at');
  if v_count <> 2 then
    raise exception 'T11: columns missing on public.users';
  end if;
  -- Call it; row.age_verified_at must be non-null for the verified
  -- adult.
  select to_jsonb(g) into v from public.get_user_self() g limit 1;
  if (v->>'age_verified_at') is null then
    raise exception 'T11: get_user_self().age_verified_at is null for verified user';
  end if;
end
$$;

-- T12: anon cannot execute attest_age.
do $$
declare
  v_can boolean;
begin
  select has_function_privilege('anon', 'public.attest_age(date, boolean)', 'EXECUTE')
    into v_can;
  if v_can then
    raise exception 'T12: anon unexpectedly has EXECUTE on attest_age';
  end if;
end
$$;

rollback;

\echo 'attest_age.test.sql: ok'
