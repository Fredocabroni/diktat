-- Behavioural tests for migration 20261201000000: signup_allow_us_territories.
--
-- Extends the signup_us_gate coverage to prove the five permanently
-- inhabited US territories (PR, GU, VI, AS, MP) are allowed through
-- the country gate in public.hook_before_user_created. Mirrors the
-- U1 / U2 structure from signup_us_gate.test.sql.
--
--   T1  PR IP → '{}' (allow).
--   T2  GU IP → '{}' (allow).
--   T3  VI IP → '{}' (allow).
--   T4  AS IP → '{}' (allow).
--   T5  MP IP → '{}' (allow).
--   T6  non-US, non-territory IP (CA) → 403 country-gate message
--       (confirms the loosening didn't accidentally allow everything).

begin;

-- Pepper fixture (same shape as signup_us_gate.test.sql).
delete from vault.secrets where name = 'age_block_pepper';
select vault.create_secret(
  'test-pepper-' || repeat('t', 52),
  'age_block_pepper',
  'test fixture — signup_allow_us_territories'
);

-- One geoip row per territory in documentation / TEST-NET ranges.
-- Six distinct /29 subnets inside 203.0.113.0/24 (TEST-NET-3) so they
-- can co-exist with the signup_us_gate fixture inside the same CI run.
-- CA uses 198.51.100.0/24 — identical to signup_us_gate for the
-- reject-case sanity check.
insert into public.geoip_country_blocks (network, country_iso) values
  ('203.0.113.16/29'::cidr, 'PR'),
  ('203.0.113.24/29'::cidr, 'GU'),
  ('203.0.113.32/29'::cidr, 'VI'),
  ('203.0.113.40/29'::cidr, 'AS'),
  ('203.0.113.48/29'::cidr, 'MP'),
  ('198.51.100.0/24'::cidr, 'CA')
on conflict (network) do update set country_iso = excluded.country_iso;

-- T1..T5 — each territory allows.
do $$
declare
  v_out jsonb;
  v_ip  text;
  v_cc  text;
  v_cases text[][] := array[
    array['203.0.113.17', 'PR'],
    array['203.0.113.25', 'GU'],
    array['203.0.113.33', 'VI'],
    array['203.0.113.41', 'AS'],
    array['203.0.113.49', 'MP']
  ];
  i int;
begin
  for i in 1..array_length(v_cases, 1) loop
    v_ip := v_cases[i][1];
    v_cc := v_cases[i][2];
    v_out := public.hook_before_user_created(
      jsonb_build_object(
        'metadata', jsonb_build_object('ip_address', v_ip),
        'user',     jsonb_build_object('email', 't' || i || '@example.com')
      )
    );
    if v_out <> '{}'::jsonb then
      raise exception 'T%: expected {} for %-country IP %, got %', i, v_cc, v_ip, v_out::text;
    end if;
  end loop;
end
$$;

-- T6 — non-allowed country still rejected.
do $$
declare
  v_out jsonb;
begin
  v_out := public.hook_before_user_created(
    jsonb_build_object(
      'metadata', jsonb_build_object('ip_address', '198.51.100.9'),
      'user',     jsonb_build_object('email', 't6@example.com')
    )
  );
  if v_out -> 'error' is null then
    raise exception 'T6: expected 403 for CA IP, got %', v_out::text;
  end if;
  if (v_out -> 'error' ->> 'http_code')::int <> 403 then
    raise exception 'T6: expected http_code=403, got %',
      v_out -> 'error' ->> 'http_code';
  end if;
  if (v_out -> 'error' ->> 'message')
     <> 'Diktat is only available in the US right now.' then
    raise exception 'T6: expected country-gate message, got %',
      v_out -> 'error' ->> 'message';
  end if;
end
$$;

delete from vault.secrets where name = 'age_block_pepper';

rollback;
\echo 'ALL signup_allow_us_territories ASSERTIONS PASSED (T1-T6)'
