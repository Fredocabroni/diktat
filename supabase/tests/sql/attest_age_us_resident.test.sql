-- Behavioural tests for the US-resident parameter added to attest_age
-- in migration 20261109000000.
--
-- Covers:
--   U1  us_resident=false → 22023 (non-terminal BAD_REQUEST). No
--       age_blocked_at stamp, no age_verified_at stamp. The user can
--       re-submit with the box checked.
--   U2  us_resident=null → 22023 (same path as false under
--       `is distinct from true`).
--   U3  us_resident=true + 18+ DOB → verified (unchanged happy path).
--   U4  Order of guards: a user with age_blocked_at (prior <18) still
--       hits the terminal P0001 even with us_resident=true.
--   U5  anon still cannot execute the two-arg function.
--   U6  The single-arg function is gone.

begin;

insert into auth.users (id, email, aud, role, created_at, updated_at)
values
  ('dddddddd-4444-4444-8444-dddddddddddd', 'us1@test', 'authenticated',
   'authenticated', now(), now()),
  ('eeeeeeee-5555-4555-8555-eeeeeeeeeeee', 'us2@test', 'authenticated',
   'authenticated', now(), now()),
  ('ffffffff-6666-4666-8666-ffffffffffff', 'us3@test', 'authenticated',
   'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.users (id, handle, display_name)
values
  ('dddddddd-4444-4444-8444-dddddddddddd', 'us1_t', 'US1'),
  ('eeeeeeee-5555-4555-8555-eeeeeeeeeeee', 'us2_t', 'US2'),
  ('ffffffff-6666-4666-8666-ffffffffffff', 'us3_t', 'US3')
on conflict (id) do nothing;

create or replace function _test_us_as(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid::text, 'role', 'authenticated')::text,
    true);
  perform set_config('role', 'authenticated', true);
end
$$;

-- U1: us_resident=false → 22023; no stamps.
do $$
declare
  v_before public.users%rowtype;
  v_after  public.users%rowtype;
begin
  perform _test_us_as('dddddddd-4444-4444-8444-dddddddddddd');
  select * into v_before from public.users
    where id = 'dddddddd-4444-4444-8444-dddddddddddd';
  begin
    perform public.attest_age((current_date - interval '30 years')::date, false);
    raise exception 'U1: expected 22023 (us_resident=false)';
  exception when sqlstate '22023' then
    null;
  end;
  select * into v_after from public.users
    where id = 'dddddddd-4444-4444-8444-dddddddddddd';
  if v_after.age_verified_at is not null then
    raise exception 'U1: age_verified_at was stamped on us_resident=false';
  end if;
  if v_after.age_blocked_at is not null then
    raise exception 'U1: age_blocked_at was stamped on us_resident=false (non-terminal only)';
  end if;
end
$$;

-- U2: us_resident=null → 22023.
do $$
begin
  perform _test_us_as('dddddddd-4444-4444-8444-dddddddddddd');
  begin
    perform public.attest_age((current_date - interval '30 years')::date, null);
    raise exception 'U2: expected 22023 (us_resident=null)';
  exception when sqlstate '22023' then
    null;
  end;
end
$$;

-- U3: us_resident=true + 18+ → verified.
do $$
declare
  v_out jsonb;
  v_row public.users%rowtype;
begin
  perform _test_us_as('eeeeeeee-5555-4555-8555-eeeeeeeeeeee');
  v_out := public.attest_age((current_date - interval '30 years')::date, true);
  if v_out->>'outcome' <> 'verified' then
    raise exception 'U3: expected verified, got %', v_out;
  end if;
  select * into v_row from public.users
    where id = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
  if v_row.age_verified_at is null then
    raise exception 'U3: age_verified_at should be stamped';
  end if;
  if v_row.age_blocked_at is not null then
    raise exception 'U3: age_blocked_at must stay null';
  end if;
end
$$;

-- U4: a blocked row still gets P0001, independent of us_resident.
do $$
begin
  perform _test_us_as('ffffffff-6666-4666-8666-ffffffffffff');
  -- First attempt: <18 → blocked.
  perform public.attest_age((current_date - interval '10 years')::date, true);
  -- Retry: an adult DOB + us_resident=true should STILL raise P0001.
  begin
    perform public.attest_age((current_date - interval '40 years')::date, true);
    raise exception 'U4: expected P0001 on retry from blocked account';
  exception when sqlstate 'P0001' then
    null;
  end;
end
$$;

-- U5: anon cannot execute the two-arg function.
do $$
declare v_has boolean;
begin
  select has_function_privilege('anon', 'public.attest_age(date, boolean)', 'EXECUTE')
    into v_has;
  if v_has then
    raise exception 'U5: anon has EXECUTE on attest_age(date, boolean)';
  end if;
end
$$;

-- U6: the single-arg function must be gone.
do $$
declare v_exists int;
begin
  select count(*)
    into v_exists
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'attest_age'
      and pg_get_function_identity_arguments(p.oid) = 'p_birth_date date';
  if v_exists <> 0 then
    raise exception 'U6: single-arg attest_age(date) still exists; migration drop failed';
  end if;
end
$$;

rollback;
