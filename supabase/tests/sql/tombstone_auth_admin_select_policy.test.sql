-- Behavioural tests for migration 20261121000000: explicit
-- supabase_auth_admin SELECT policies on both tombstone tables.
--
-- The point of these tests is to exercise the hook ON THE PRODUCTION
-- READ PATH (as supabase_auth_admin), not under 'postgres' — every
-- existing age_block_tombstone / tombstone_hardening test runs as
-- postgres, which has BYPASSRLS on this project and therefore cannot
-- distinguish "hook works because BYPASSRLS" from "hook works because
-- an explicit policy fires." Running the hook under supabase_auth_admin
-- exercises the policies added by this migration.
--
--   P1  hook_before_user_created rejects a seeded tombstoned email
--       (403) when called as supabase_auth_admin.
--   P2  hook_before_user_created rejects a seeded identity tombstone
--       (403) when called as supabase_auth_admin.
--   P3  Policy inventory: both tables now have exactly one SELECT
--       policy whose target role is supabase_auth_admin.
--
-- The 'postgres' role (used by the psql harness) is a superuser in
-- local Supabase dev, so `set local role supabase_auth_admin` succeeds.
-- If a future harness runs as a non-superuser that is not a member of
-- supabase_auth_admin, the role switch will error — this file should
-- NOT be silently patched to fall back to 'postgres' (that defeats
-- the whole point of the file; see the age_block_tombstone.test.sql
-- caveat note).

begin;

-- --------------------------------------------------------------------
-- Pepper seed. Both the sweep and the hook hash via
-- public._age_block_hash, which raises when the Vault secret
-- 'age_block_pepper' is missing or too short. Seed a fixed 64-char
-- test pepper so _age_block_hash works deterministically in this file.
-- Cleaned at the end.
-- --------------------------------------------------------------------
delete from vault.secrets where name = 'age_block_pepper';
select vault.create_secret(
  'test-pepper-tombstone-auth-admin-select-policy-0123456789abcd',
  'age_block_pepper',
  'test pepper for tombstone_auth_admin_select_policy.test.sql'
);

-- --------------------------------------------------------------------
-- Seed: insert one tombstone in each table for a known fixture.
-- Writes go through the sweep's SECURITY DEFINER owner-chain in prod;
-- in tests we seed the tables directly (as postgres, which has
-- BYPASSRLS, so RLS doesn't block this seed) and then flip the role
-- for the actual hook assertion.
-- --------------------------------------------------------------------
do $$
declare
  v_email_hash    text := public._age_block_hash('victim.policy@example.com');
  v_identity_hash text := public._age_block_hash('twitter:policy-oauth-id-123');
begin
  insert into public.age_block_tombstones (email_hash, expires_at)
       values (v_email_hash, now() + interval '1 year')
  on conflict (email_hash) do update set expires_at = excluded.expires_at;

  insert into public.age_block_identity_tombstones (identity_hash, expires_at)
       values (v_identity_hash, now() + interval '1 year')
  on conflict (identity_hash) do update set expires_at = excluded.expires_at;
end
$$;

-- --------------------------------------------------------------------
-- P1: hook rejects a seeded tombstoned email with http_code 403 when
-- invoked as supabase_auth_admin. This is the production read path.
-- --------------------------------------------------------------------
do $$
declare
  v_out jsonb;
begin
  set local role supabase_auth_admin;
  v_out := public.hook_before_user_created(
    jsonb_build_object(
      'metadata', jsonb_build_object(
        'name', 'before-user-created',
        'ip_address', '127.0.0.1'
      ),
      'user', jsonb_build_object(
        'email', 'victim.policy@example.com'
      )
    )
  );
  if v_out->'error' is null then
    raise exception 'P1: hook did not reject tombstoned email under supabase_auth_admin, got %', v_out::text;
  end if;
  if (v_out->'error'->>'http_code')::int <> 403 then
    raise exception 'P1: expected http_code=403, got %',
      v_out->'error'->>'http_code';
  end if;
end
$$;

-- --------------------------------------------------------------------
-- P2: hook rejects a seeded identity tombstone with http_code 403 when
-- invoked as supabase_auth_admin.
-- --------------------------------------------------------------------
do $$
declare
  v_out jsonb;
begin
  set local role supabase_auth_admin;
  v_out := public.hook_before_user_created(
    jsonb_build_object(
      'metadata', jsonb_build_object(
        'name', 'before-user-created',
        'ip_address', '127.0.0.1'
      ),
      'user', jsonb_build_object(
        'email', 'fresh.email.not.tombstoned@example.com',
        'identities', jsonb_build_array(
          jsonb_build_object(
            'provider', 'twitter',
            'id',       'policy-oauth-id-123'
          )
        )
      )
    )
  );
  if v_out->'error' is null then
    raise exception 'P2: hook did not reject tombstoned identity under supabase_auth_admin, got %', v_out::text;
  end if;
  if (v_out->'error'->>'http_code')::int <> 403 then
    raise exception 'P2: expected http_code=403, got %',
      v_out->'error'->>'http_code';
  end if;
end
$$;

-- --------------------------------------------------------------------
-- P3: policy inventory — each table has exactly one SELECT policy
-- whose target role list is {supabase_auth_admin}.
-- --------------------------------------------------------------------
do $$
declare
  v_count int;
begin
  select count(*)
    into v_count
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'age_block_tombstones'
      and cmd        = 'SELECT'
      and roles      = array['supabase_auth_admin']::name[];
  if v_count <> 1 then
    raise exception 'P3: expected 1 SELECT-to-supabase_auth_admin policy on age_block_tombstones, got %',
      v_count;
  end if;

  select count(*)
    into v_count
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'age_block_identity_tombstones'
      and cmd        = 'SELECT'
      and roles      = array['supabase_auth_admin']::name[];
  if v_count <> 1 then
    raise exception 'P3: expected 1 SELECT-to-supabase_auth_admin policy on age_block_identity_tombstones, got %',
      v_count;
  end if;
end
$$;

-- Clean up the test pepper so a re-run starts fresh.
delete from vault.secrets where name = 'age_block_pepper';

rollback;
