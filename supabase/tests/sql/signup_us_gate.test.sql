-- Behavioural tests for migration 20261124000000: signup_us_gate.
--
-- Covers the country-gate added to public.hook_before_user_created.
-- Each test runs as postgres (BYPASSRLS), the same affordance the
-- tombstone_hardening tests rely on. Mutations live inside a single
-- outer BEGIN ... ROLLBACK so the seeded fixtures (geoip rows, test
-- pepper, and the age-block tombstone row for U6) are not visible
-- outside this transaction.
--
--   U1  US IP → '{}' (allow).
--   U2  non-US IP → 403 with the country-gate message.
--   U3  unlisted IP (no CIDR covers it) → '{}' (allow).
--   U4  missing metadata.ip_address → '{}' (allow).
--   U5  garbage ip string → '{}' (allow; the inner exception block
--       absorbs the invalid_text_representation on the ::inet cast
--       and the outer fail-open handler never fires, i.e. the test
--       passes without the hook emitting a warning).
--   U6  tombstoned email + US IP → 403 with the TOMBSTONE message
--       (not the country message) — existing behaviour intact, the
--       country check runs after and only when the email check falls
--       through.

begin;

-- --------------------------------------------------------------------
-- Fixtures.
-- --------------------------------------------------------------------
-- A valid pepper so the HMAC helper does not raise (otherwise the
-- email check in the hook catches via the outer fail-open handler and
-- returns {}, which would hide the email-vs-country ordering test
-- in U6).
delete from vault.secrets where name = 'age_block_pepper';
select vault.create_secret(
  'test-pepper-' || repeat('u', 52),
  'age_block_pepper',
  'test fixture — signup_us_gate'
);

-- Two GeoLite fixture rows, in TEST-NET-3 / documentation ranges so
-- they cannot collide with prod MaxMind data (which will not be loaded
-- in CI, but we're paranoid). `on conflict do update` keeps this
-- idempotent against any accidental prior row.
insert into public.geoip_country_blocks (network, country_iso)
values
  ('203.0.113.0/24'::cidr, 'US'),
  ('198.51.100.0/24'::cidr, 'CA')
on conflict (network) do update set country_iso = excluded.country_iso;

-- --------------------------------------------------------------------
-- U1 — US IP → allow.
-- --------------------------------------------------------------------
do $$
declare
  v_out jsonb;
begin
  v_out := public.hook_before_user_created(
    jsonb_build_object(
      'metadata', jsonb_build_object('ip_address', '203.0.113.7'),
      'user',     jsonb_build_object('email', 'u1@example.com')
    )
  );
  if v_out <> '{}'::jsonb then
    raise exception 'U1: expected {} for US IP, got %', v_out::text;
  end if;
end
$$;

-- --------------------------------------------------------------------
-- U2 — non-US IP → 403 with the country-gate message.
-- --------------------------------------------------------------------
do $$
declare
  v_out jsonb;
begin
  v_out := public.hook_before_user_created(
    jsonb_build_object(
      'metadata', jsonb_build_object('ip_address', '198.51.100.9'),
      'user',     jsonb_build_object('email', 'u2@example.com')
    )
  );
  if v_out -> 'error' is null then
    raise exception 'U2: expected 403 error envelope for non-US IP, got %',
      v_out::text;
  end if;
  if (v_out -> 'error' ->> 'http_code')::int <> 403 then
    raise exception 'U2: expected http_code=403, got %',
      v_out -> 'error' ->> 'http_code';
  end if;
  if (v_out -> 'error' ->> 'message')
     <> 'Diktat is only available in the US right now.' then
    raise exception 'U2: expected country-gate message, got %',
      v_out -> 'error' ->> 'message';
  end if;
end
$$;

-- --------------------------------------------------------------------
-- U3 — unlisted IP (no CIDR covers it) → allow.
-- Picks an address in 192.0.2.0/24 (TEST-NET-1) which neither fixture
-- range covers; geoip_country returns NULL and the gate must let it
-- through.
-- --------------------------------------------------------------------
do $$
declare
  v_out jsonb;
begin
  -- Sanity: the fixtures do NOT already cover this address.
  if public.geoip_country('192.0.2.5'::inet) is not null then
    raise exception 'U3 pre-check: 192.0.2.5 is covered by an existing geoip row (test fixture collision)';
  end if;
  v_out := public.hook_before_user_created(
    jsonb_build_object(
      'metadata', jsonb_build_object('ip_address', '192.0.2.5'),
      'user',     jsonb_build_object('email', 'u3@example.com')
    )
  );
  if v_out <> '{}'::jsonb then
    raise exception 'U3: expected {} for unlisted IP, got %', v_out::text;
  end if;
end
$$;

-- --------------------------------------------------------------------
-- U4 — missing metadata.ip_address → allow.
-- Covers the admin-API path where the Go struct emits no ip_address
-- (omitempty).
-- --------------------------------------------------------------------
do $$
declare
  v_out jsonb;
begin
  v_out := public.hook_before_user_created(
    jsonb_build_object(
      'metadata', jsonb_build_object(),
      'user',     jsonb_build_object('email', 'u4@example.com')
    )
  );
  if v_out <> '{}'::jsonb then
    raise exception 'U4: expected {} for missing ip_address, got %', v_out::text;
  end if;

  -- Also: no metadata key at all → allow (shape-tolerant on top of
  -- omitempty).
  v_out := public.hook_before_user_created(
    jsonb_build_object(
      'user', jsonb_build_object('email', 'u4b@example.com')
    )
  );
  if v_out <> '{}'::jsonb then
    raise exception 'U4: expected {} for absent metadata, got %', v_out::text;
  end if;
end
$$;

-- --------------------------------------------------------------------
-- U5 — garbage IP string → allow (inner ::inet cast catches, outer
-- fail-open never fires).
-- --------------------------------------------------------------------
do $$
declare
  v_out jsonb;
begin
  -- Non-parseable string.
  v_out := public.hook_before_user_created(
    jsonb_build_object(
      'metadata', jsonb_build_object('ip_address', 'not-an-ip'),
      'user',     jsonb_build_object('email', 'u5@example.com')
    )
  );
  if v_out <> '{}'::jsonb then
    raise exception 'U5: expected {} for garbage IP, got %', v_out::text;
  end if;

  -- Empty string (btrim trips, never reaches the cast).
  v_out := public.hook_before_user_created(
    jsonb_build_object(
      'metadata', jsonb_build_object('ip_address', '   '),
      'user',     jsonb_build_object('email', 'u5b@example.com')
    )
  );
  if v_out <> '{}'::jsonb then
    raise exception 'U5: expected {} for whitespace IP, got %', v_out::text;
  end if;

  -- Non-string ip_address (jsonb number): `->>` yields the number as
  -- text, which fails ::inet. Inner exception absorbs, allow.
  v_out := public.hook_before_user_created(
    jsonb_build_object(
      'metadata', jsonb_build_object('ip_address', 42),
      'user',     jsonb_build_object('email', 'u5c@example.com')
    )
  );
  if v_out <> '{}'::jsonb then
    raise exception 'U5: expected {} for numeric ip_address, got %', v_out::text;
  end if;
end
$$;

-- --------------------------------------------------------------------
-- U6 — tombstoned email + US IP → tombstone 403, NOT country 403.
-- Proves the country check runs AFTER the email check and only when
-- the email check falls through.
-- --------------------------------------------------------------------
do $$
declare
  v_hash  text;
  v_out   jsonb;
  v_msg   text;
begin
  v_hash := public._age_block_hash('u6-tombstoned@example.com');
  if v_hash is null then
    raise exception 'U6 pre-check: _age_block_hash returned null (pepper missing?)';
  end if;
  insert into public.age_block_tombstones (email_hash, expires_at)
  values (v_hash, now() + interval '1 year')
  on conflict (email_hash) do update set expires_at = excluded.expires_at;

  v_out := public.hook_before_user_created(
    jsonb_build_object(
      -- US IP so the country gate alone would pass.
      'metadata', jsonb_build_object('ip_address', '203.0.113.7'),
      'user',     jsonb_build_object('email', 'u6-tombstoned@example.com')
    )
  );
  if v_out -> 'error' is null then
    raise exception 'U6: tombstoned email was not rejected, got %', v_out::text;
  end if;
  if (v_out -> 'error' ->> 'http_code')::int <> 403 then
    raise exception 'U6: expected http_code=403, got %',
      v_out -> 'error' ->> 'http_code';
  end if;
  v_msg := v_out -> 'error' ->> 'message';
  if v_msg <> 'Signup not permitted for this email.' then
    raise exception
      'U6: expected tombstone message (not country message), got "%"',
      v_msg;
  end if;
end
$$;

-- Clean up the test pepper so a re-run starts fresh.
delete from vault.secrets where name = 'age_block_pepper';

rollback;
