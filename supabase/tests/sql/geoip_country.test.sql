-- Behavioural tests for migration 20261123000000: geoip_country_table.
--
-- Does NOT download MaxMind. Seeds two fixture rows (one IPv4, one
-- IPv6) and exercises public.geoip_country() against addresses inside
-- each range and an address outside every range.
--
--   G1  IPv4 fixture: address inside the US range → 'US'.
--   G2  IPv6 fixture: address inside the GB range → 'GB'.
--   G3  Address outside every fixture range → NULL.
--   G4  Most-specific match wins (overlapping CIDRs): a /32 inside a
--       /24 returns the /32's country.
--   G5  RLS posture: exactly one SELECT policy on public.geoip_country_blocks
--       whose target role list is {supabase_auth_admin}; anon /
--       authenticated have no SELECT or INSERT privilege on the table.
--   G6  Function grant posture: public / anon / authenticated lack
--       EXECUTE on public.geoip_country(inet); supabase_auth_admin and
--       service_role have EXECUTE.

begin;

-- Seed fixtures. Seeds run as postgres (harness BYPASSRLS), which is
-- fine — service_role is the loader's role in prod; this file doesn't
-- try to exercise the loader path.
insert into public.geoip_country_blocks (network, country_iso)
values
  ('203.0.113.0/24'::cidr,   'US'),
  ('2001:db8::/32'::cidr,    'GB'),
  -- G4 fixture: a /32 nested inside the /24 above, different country.
  ('203.0.113.42/32'::cidr,  'CA');

-- --------------------------------------------------------------------
-- G1: IPv4 address inside the US /24 → 'US'.
-- --------------------------------------------------------------------
do $$
declare
  v_got text;
begin
  v_got := public.geoip_country('203.0.113.5'::inet);
  if v_got is distinct from 'US' then
    raise exception 'G1: expected US for 203.0.113.5, got %',
      coalesce(v_got, '<null>');
  end if;
end
$$;

-- --------------------------------------------------------------------
-- G2: IPv6 address inside the GB /32 → 'GB'.
-- --------------------------------------------------------------------
do $$
declare
  v_got text;
begin
  v_got := public.geoip_country('2001:db8::1'::inet);
  if v_got is distinct from 'GB' then
    raise exception 'G2: expected GB for 2001:db8::1, got %',
      coalesce(v_got, '<null>');
  end if;
end
$$;

-- --------------------------------------------------------------------
-- G3: Address outside every fixture range → NULL.
-- --------------------------------------------------------------------
do $$
declare
  v_got text;
begin
  v_got := public.geoip_country('198.51.100.1'::inet);
  if v_got is not null then
    raise exception 'G3: expected NULL for 198.51.100.1, got %', v_got;
  end if;

  v_got := public.geoip_country('2001:db9::1'::inet);
  if v_got is not null then
    raise exception 'G3: expected NULL for 2001:db9::1, got %', v_got;
  end if;
end
$$;

-- --------------------------------------------------------------------
-- G4: Most-specific CIDR wins. The /32 at 203.0.113.42 nested inside
-- the /24 should return CA (not US).
-- --------------------------------------------------------------------
do $$
declare
  v_got text;
begin
  v_got := public.geoip_country('203.0.113.42'::inet);
  if v_got is distinct from 'CA' then
    raise exception 'G4: expected CA for 203.0.113.42 (/32 nested in /24), got %',
      coalesce(v_got, '<null>');
  end if;
end
$$;

-- --------------------------------------------------------------------
-- G5: RLS posture on public.geoip_country_blocks.
-- --------------------------------------------------------------------
do $$
declare
  v_rls   boolean;
  v_count int;
begin
  select relrowsecurity
    into v_rls
    from pg_class
    where oid = 'public.geoip_country_blocks'::regclass;
  if not v_rls then
    raise exception 'G5: geoip_country_blocks has RLS disabled';
  end if;

  select count(*)
    into v_count
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'geoip_country_blocks'
      and cmd        = 'SELECT'
      and roles      = array['supabase_auth_admin']::name[];
  if v_count <> 1 then
    raise exception 'G5: expected 1 SELECT-to-supabase_auth_admin policy on geoip_country_blocks, got %',
      v_count;
  end if;

  if has_table_privilege('anon', 'public.geoip_country_blocks', 'SELECT')
     or has_table_privilege('authenticated', 'public.geoip_country_blocks', 'SELECT')
     or has_table_privilege('anon', 'public.geoip_country_blocks', 'INSERT')
     or has_table_privilege('authenticated', 'public.geoip_country_blocks', 'INSERT') then
    raise exception 'G5: geoip_country_blocks exposes SELECT/INSERT to anon/authenticated';
  end if;

  if not has_table_privilege(
       'supabase_auth_admin', 'public.geoip_country_blocks', 'SELECT'
     ) then
    raise exception 'G5: supabase_auth_admin lacks SELECT on geoip_country_blocks';
  end if;
end
$$;

-- --------------------------------------------------------------------
-- G6: Function grant posture on public.geoip_country(inet).
-- --------------------------------------------------------------------
do $$
begin
  if has_function_privilege('public',
       'public.geoip_country(inet)', 'EXECUTE') then
    raise exception 'G6: public has EXECUTE on geoip_country(inet)';
  end if;
  if has_function_privilege('anon',
       'public.geoip_country(inet)', 'EXECUTE') then
    raise exception 'G6: anon has EXECUTE on geoip_country(inet)';
  end if;
  if has_function_privilege('authenticated',
       'public.geoip_country(inet)', 'EXECUTE') then
    raise exception 'G6: authenticated has EXECUTE on geoip_country(inet)';
  end if;
  if not has_function_privilege('supabase_auth_admin',
       'public.geoip_country(inet)', 'EXECUTE') then
    raise exception 'G6: supabase_auth_admin lacks EXECUTE on geoip_country(inet)';
  end if;
  if not has_function_privilege('service_role',
       'public.geoip_country(inet)', 'EXECUTE') then
    raise exception 'G6: service_role lacks EXECUTE on geoip_country(inet)';
  end if;
end
$$;

rollback;
