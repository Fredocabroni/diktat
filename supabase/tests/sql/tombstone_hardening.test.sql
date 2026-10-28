-- Behavioural tests for migration 20261120000000: age-block tombstone
-- hardening.
--
-- Covers:
--   H1  HMAC deterministic — same input + same pepper → same hash.
--       Distinct inputs → distinct hashes.
--   H2  HMAC differs from plain encode(sha256(..), 'hex') — proves
--       the pepper is actually keyed.
--   H3  Hook FAILS OPEN without pepper — hook returns {} even for an
--       email whose plain-SHA256 is in age_block_tombstones.
--   H4  Live sweep FAILS CLOSED without pepper — raises; no deletes.
--   H5  Dry-run sweep OK without pepper — no raise; no writes.
--   H6  Identity tombstone round-trip — sweep writes
--       age_block_identity_tombstones for the victim's auth.identities
--       row; a subsequent hook call carrying that identity returns 403.
--   H7  Least privilege — supabase_auth_admin has SELECT on both
--       tombstone tables; INSERT/UPDATE/DELETE are revoked.
--   H8  _age_block_hash grants — anon/authenticated/public lack
--       EXECUTE; supabase_auth_admin has EXECUTE.
--   H9  key_version default — rows written by the live sweep carry
--       key_version = 1.
--
-- The 'postgres' owner role has BYPASSRLS; this is the same affordance
-- data_minimization_sweep.test.sql and age_block_tombstone.test.sql
-- rely on.

begin;

-- --------------------------------------------------------------------
-- Clean slate: ensure no stale pepper from a prior run.
-- --------------------------------------------------------------------
delete from vault.secrets where name = 'age_block_pepper';

-- --------------------------------------------------------------------
-- Fixtures.
-- --------------------------------------------------------------------
-- Two humans: both age-blocked. One has only an email (H1/H2/H9), the
-- other has both email + an OAuth identity (H6).
insert into auth.users (id, email, aud, role, raw_app_meta_data, created_at, updated_at)
values
  ('d4d4d4d4-0004-4004-8004-d4d4d4d4d4d4', 'hard.t1@example.com',
   'authenticated', 'authenticated', '{}'::jsonb,
   now() - interval '20 days', now()),
  ('e5e5e5e5-0005-4005-8005-e5e5e5e5e5e5', 'hard.oauth@example.com',
   'authenticated', 'authenticated', '{}'::jsonb,
   now() - interval '20 days', now())
on conflict (id) do nothing;

update public.users
   set handle = 'h_t1', display_name = 'HardT1',
       created_at = now() - interval '20 days'
 where id = 'd4d4d4d4-0004-4004-8004-d4d4d4d4d4d4';
update public.users
   set handle = 'h_oauth', display_name = 'HardOAuth',
       created_at = now() - interval '20 days'
 where id = 'e5e5e5e5-0005-4005-8005-e5e5e5e5e5e5';

update public.users
   set age_blocked_at = created_at + interval '2 hours',
       age_verified_at = null
 where id in (
   'd4d4d4d4-0004-4004-8004-d4d4d4d4d4d4',
   'e5e5e5e5-0005-4005-8005-e5e5e5e5e5e5'
 );

-- auth.identities row for the OAuth victim. provider='twitter',
-- provider_id='X-oauth-user-123'. identity_data must satisfy the
-- NOT NULL constraint; shape is per Supabase defaults.
insert into auth.identities (id, user_id, provider, provider_id, identity_data, created_at, updated_at)
values (
  gen_random_uuid()::text,
  'e5e5e5e5-0005-4005-8005-e5e5e5e5e5e5',
  'twitter',
  'X-oauth-user-123',
  '{"sub": "X-oauth-user-123", "provider_id": "X-oauth-user-123"}'::jsonb,
  now() - interval '20 days',
  now()
)
on conflict do nothing;

-- Fixed pepper for the pepper-present tests. 64 hex chars, test only.
select vault.create_secret(
  'test-pepper-' || repeat('a', 52),
  'age_block_pepper',
  'test fixture — not for production use'
);

-- --------------------------------------------------------------------
-- H1 — HMAC deterministic + input-sensitive.
-- --------------------------------------------------------------------
do $$
declare
  v_a text;
  v_b text;
  v_c text;
begin
  perform set_config('role', 'postgres', true);
  v_a := public._age_block_hash('hard.t1@example.com');
  v_b := public._age_block_hash('hard.t1@example.com');
  v_c := public._age_block_hash('other.user@example.com');
  if v_a is null or v_a = '' then
    raise exception 'H1: _age_block_hash returned null/empty with pepper set';
  end if;
  if v_a <> v_b then
    raise exception 'H1: HMAC not deterministic (% vs %)', v_a, v_b;
  end if;
  if v_a = v_c then
    raise exception 'H1: distinct inputs produced equal hashes';
  end if;
end
$$;

-- --------------------------------------------------------------------
-- H2 — HMAC differs from plain SHA-256(lower(btrim(..))).
-- --------------------------------------------------------------------
do $$
declare
  v_hmac   text;
  v_plain  text;
begin
  perform set_config('role', 'postgres', true);
  v_hmac := public._age_block_hash('hard.t1@example.com');
  v_plain := encode(
    pg_catalog.sha256(lower(btrim('hard.t1@example.com'))::bytea),
    'hex'
  );
  if v_hmac = v_plain then
    raise exception 'H2: HMAC equals plain SHA-256 — pepper has no effect';
  end if;
end
$$;

-- --------------------------------------------------------------------
-- H3 — Hook FAILS OPEN without pepper.
-- --------------------------------------------------------------------
-- Pre-seed age_block_tombstones with a PLAIN-sha256 row for an email,
-- delete the pepper, call the hook with that email. If the hook were
-- still using plain SHA-256 (regression) the row would match and the
-- hook would reject with 403. With the new HMAC path AND no pepper,
-- the hash call raises, the hook catches, and returns {}.
do $$
declare
  v_plain_hash text;
  v_out        jsonb;
begin
  perform set_config('role', 'postgres', true);

  v_plain_hash := encode(
    pg_catalog.sha256(lower(btrim('failopen@example.com'))::bytea),
    'hex'
  );
  insert into public.age_block_tombstones (email_hash, expires_at)
  values (v_plain_hash, now() + interval '1 year')
  on conflict (email_hash) do update set expires_at = excluded.expires_at;

  -- Pepper absent.
  delete from vault.secrets where name = 'age_block_pepper';

  v_out := public.hook_before_user_created(
    jsonb_build_object(
      'user', jsonb_build_object('email', 'failopen@example.com')
    )
  );
  if v_out <> '{}'::jsonb then
    raise exception 'H3: hook did not fail open without pepper, got %',
      v_out::text;
  end if;
end
$$;

-- --------------------------------------------------------------------
-- H4 — Live sweep FAILS CLOSED without pepper.
-- --------------------------------------------------------------------
do $$
declare
  v_raised  boolean := false;
  v_err     text;
  v_before  int;
  v_after   int;
begin
  perform set_config('role', 'postgres', true);

  -- Pepper still absent from H3.
  select count(*) into v_before from auth.users
   where id in (
     'd4d4d4d4-0004-4004-8004-d4d4d4d4d4d4',
     'e5e5e5e5-0005-4005-8005-e5e5e5e5e5e5'
   );

  begin
    perform public.data_minimization_sweep(false);
  exception when others then
    v_raised := true;
    v_err := sqlerrm;
  end;

  if not v_raised then
    raise exception 'H4: live sweep did not raise with no pepper';
  end if;
  if v_err not like '%age_block_pepper%' then
    raise exception 'H4: raise did not name the missing secret: %', v_err;
  end if;

  -- No victims deleted — the raise aborted the sweep transaction.
  -- Our outer test transaction continues because the sweep call was
  -- wrapped in a sub-block.
  select count(*) into v_after from auth.users
   where id in (
     'd4d4d4d4-0004-4004-8004-d4d4d4d4d4d4',
     'e5e5e5e5-0005-4005-8005-e5e5e5e5e5e5'
   );
  if v_after <> v_before then
    raise exception 'H4: sweep deleted rows despite raising (before=%, after=%)',
      v_before, v_after;
  end if;
end
$$;

-- --------------------------------------------------------------------
-- H5 — Dry-run OK without pepper.
-- --------------------------------------------------------------------
do $$
declare
  v_out jsonb;
begin
  perform set_config('role', 'postgres', true);
  -- Pepper still absent.
  v_out := public.data_minimization_sweep(true);
  if (v_out->>'tombstones_written')::int <> 0 then
    raise exception 'H5: dry-run wrote tombstones';
  end if;
  if (v_out->>'identity_tombstones_written')::int <> 0 then
    raise exception 'H5: dry-run wrote identity tombstones';
  end if;
  if (v_out->>'dry_run')::boolean is not true then
    raise exception 'H5: dry-run flag not propagated to return shape';
  end if;
end
$$;

-- --------------------------------------------------------------------
-- H6 — Identity tombstone round-trip (pepper restored).
-- --------------------------------------------------------------------
do $$
declare
  v_expected_hash  text;
  v_out            jsonb;
  v_cnt            int;
  v_hook_out       jsonb;
begin
  perform set_config('role', 'postgres', true);

  -- Restore pepper.
  select vault.create_secret(
    'test-pepper-' || repeat('b', 52),
    'age_block_pepper',
    'test fixture — H6 pepper'
  );

  -- Pre-compute what the identity_hash SHOULD be for comparison.
  v_expected_hash := public._age_block_hash('twitter:X-oauth-user-123');
  if v_expected_hash is null then
    raise exception 'H6: pre-computed identity hash is null';
  end if;

  -- Live sweep.
  v_out := public.data_minimization_sweep(false);
  if (v_out->>'identity_tombstones_written')::int < 1 then
    raise exception 'H6: expected >=1 identity_tombstones_written, got %',
      v_out->>'identity_tombstones_written';
  end if;

  select count(*)
    into v_cnt
    from public.age_block_identity_tombstones
    where identity_hash = v_expected_hash
      and expires_at > now();
  if v_cnt <> 1 then
    raise exception 'H6: expected 1 identity tombstone for twitter:X-oauth-user-123, got %', v_cnt;
  end if;

  -- Hook payload with the OAuth identity → 403.
  v_hook_out := public.hook_before_user_created(
    jsonb_build_object(
      'user', jsonb_build_object(
        'email', '',
        'identities', jsonb_build_array(
          jsonb_build_object(
            'provider',    'twitter',
            'provider_id', 'X-oauth-user-123'
          )
        )
      )
    )
  );
  if v_hook_out->'error' is null then
    raise exception 'H6: hook did not reject tombstoned identity, got %',
      v_hook_out::text;
  end if;
  if (v_hook_out->'error'->>'http_code')::int <> 403 then
    raise exception 'H6: expected http_code=403, got %',
      v_hook_out->'error'->>'http_code';
  end if;
end
$$;

-- --------------------------------------------------------------------
-- H7 — Least privilege on both tombstone tables.
-- --------------------------------------------------------------------
do $$
begin
  -- Email tombstones.
  if not has_table_privilege('supabase_auth_admin',
       'public.age_block_tombstones', 'SELECT') then
    raise exception 'H7: supabase_auth_admin lacks SELECT on age_block_tombstones';
  end if;
  if has_table_privilege('supabase_auth_admin',
       'public.age_block_tombstones', 'INSERT') then
    raise exception 'H7: supabase_auth_admin has INSERT on age_block_tombstones';
  end if;
  if has_table_privilege('supabase_auth_admin',
       'public.age_block_tombstones', 'UPDATE') then
    raise exception 'H7: supabase_auth_admin has UPDATE on age_block_tombstones';
  end if;
  if has_table_privilege('supabase_auth_admin',
       'public.age_block_tombstones', 'DELETE') then
    raise exception 'H7: supabase_auth_admin has DELETE on age_block_tombstones';
  end if;

  -- Identity tombstones.
  if not has_table_privilege('supabase_auth_admin',
       'public.age_block_identity_tombstones', 'SELECT') then
    raise exception 'H7: supabase_auth_admin lacks SELECT on age_block_identity_tombstones';
  end if;
  if has_table_privilege('supabase_auth_admin',
       'public.age_block_identity_tombstones', 'INSERT') then
    raise exception 'H7: supabase_auth_admin has INSERT on age_block_identity_tombstones';
  end if;
  if has_table_privilege('supabase_auth_admin',
       'public.age_block_identity_tombstones', 'UPDATE') then
    raise exception 'H7: supabase_auth_admin has UPDATE on age_block_identity_tombstones';
  end if;
  if has_table_privilege('supabase_auth_admin',
       'public.age_block_identity_tombstones', 'DELETE') then
    raise exception 'H7: supabase_auth_admin has DELETE on age_block_identity_tombstones';
  end if;

  -- anon / authenticated must not see either table.
  if has_table_privilege('anon', 'public.age_block_identity_tombstones', 'SELECT')
     or has_table_privilege('authenticated', 'public.age_block_identity_tombstones', 'SELECT')
     or has_table_privilege('anon', 'public.age_block_identity_tombstones', 'INSERT')
     or has_table_privilege('authenticated', 'public.age_block_identity_tombstones', 'INSERT') then
    raise exception 'H7: identity tombstones exposed to anon/authenticated';
  end if;
end
$$;

-- --------------------------------------------------------------------
-- H8 — _age_block_hash grants.
-- --------------------------------------------------------------------
do $$
begin
  if has_function_privilege('anon',
       'public._age_block_hash(text)', 'EXECUTE') then
    raise exception 'H8: anon has EXECUTE on _age_block_hash';
  end if;
  if has_function_privilege('authenticated',
       'public._age_block_hash(text)', 'EXECUTE') then
    raise exception 'H8: authenticated has EXECUTE on _age_block_hash';
  end if;
  if has_function_privilege('public',
       'public._age_block_hash(text)', 'EXECUTE') then
    raise exception 'H8: public has EXECUTE on _age_block_hash';
  end if;
  if not has_function_privilege('supabase_auth_admin',
       'public._age_block_hash(text)', 'EXECUTE') then
    raise exception 'H8: supabase_auth_admin lacks EXECUTE on _age_block_hash';
  end if;
end
$$;

-- --------------------------------------------------------------------
-- H9 — key_version default on sweep-written rows.
-- --------------------------------------------------------------------
do $$
declare
  v_bad int;
begin
  select count(*)
    into v_bad
    from public.age_block_tombstones
    where key_version is distinct from 1;
  if v_bad <> 0 then
    raise exception 'H9: % age_block_tombstones rows have key_version <> 1',
      v_bad;
  end if;
  select count(*)
    into v_bad
    from public.age_block_identity_tombstones
    where key_version is distinct from 1;
  if v_bad <> 0 then
    raise exception 'H9: % age_block_identity_tombstones rows have key_version <> 1',
      v_bad;
  end if;
end
$$;

-- Clean up the test pepper so a re-run starts fresh.
delete from vault.secrets where name = 'age_block_pepper';

rollback;
