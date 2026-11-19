-- Migration: signup_allow_us_territories
--
-- Loosens the country gate in public.hook_before_user_created from
-- "US only" to "US + the five permanently inhabited US territories":
-- Puerto Rico (PR), Guam (GU), US Virgin Islands (VI), American
-- Samoa (AS), Northern Mariana Islands (MP). Vercel's
-- `x-vercel-ip-country` header and MaxMind GeoLite both report the
-- territories as distinct codes (not 'US'); the earlier
-- `v_country <> 'US'` check was blocking US persons living in the
-- territories at the Supabase Auth Before-User-Created hook.
--
-- Rest of the hook body (email tombstone, identity tombstone, inner
-- IP-parse exception, outer fail-open handler) is kept byte-for-byte
-- from 20261124000000. Only the single country-match predicate
-- changes.
--
-- Access posture + comment kept.
--
-- Down: restore the exact 20261124000000 body (single `v_country <> 'US'`).

begin;

create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_user         jsonb;
  v_email        text;
  v_hash         text;
  v_blocked      boolean;
  v_identity     jsonb;
  v_provider     text;
  v_provider_id  text;
  v_ip_text      text;
  v_ip           inet;
  v_country      text;
  -- US + the five permanently inhabited US territories. Must stay in
  -- lockstep with apps/web/lib/country-gate.ts (web client + edge
  -- callback share the same list on the TypeScript side).
  c_allowed_countries constant text[] := array['US','PR','GU','VI','AS','MP'];
begin
  v_user := event -> 'user';

  -- (a) Email path.
  v_email := v_user ->> 'email';
  if v_email is not null and btrim(v_email) <> '' then
    v_hash := public._age_block_hash(v_email);
    if v_hash is not null then
      v_blocked := null;
      select true
        into v_blocked
        from public.age_block_tombstones
        where email_hash = v_hash
          and expires_at > now()
        limit 1;
      if v_blocked is true then
        return jsonb_build_object(
          'error', jsonb_build_object(
            'message',   'Signup not permitted for this email.',
            'http_code', 403
          )
        );
      end if;
    end if;
  end if;

  -- (b) Identity path.
  for v_identity in
    select *
      from jsonb_array_elements(
        coalesce(v_user -> 'identities', '[]'::jsonb)
      )
  loop
    v_provider    := v_identity ->> 'provider';
    v_provider_id := coalesce(
      v_identity ->> 'provider_id',
      v_identity ->> 'id'
    );
    if v_provider is not null and v_provider_id is not null
       and btrim(v_provider) <> '' and btrim(v_provider_id) <> '' then
      v_hash := public._age_block_hash(v_provider || ':' || v_provider_id);
      if v_hash is not null then
        v_blocked := null;
        select true
          into v_blocked
          from public.age_block_identity_tombstones
          where identity_hash = v_hash
            and expires_at > now()
          limit 1;
        if v_blocked is true then
          return jsonb_build_object(
            'error', jsonb_build_object(
              'message',   'Signup not permitted for this account.',
              'http_code', 403
            )
          );
        end if;
      end if;
    end if;
  end loop;

  -- (c) Country path. Allow US + 5 territories; reject anything else
  -- that resolves to a non-null country code.
  v_ip_text := event -> 'metadata' ->> 'ip_address';
  if v_ip_text is not null and btrim(v_ip_text) <> '' then
    begin
      v_ip := v_ip_text::inet;
    exception when others then
      v_ip := null;
    end;

    if v_ip is not null then
      v_country := public.geoip_country(v_ip);
      if v_country is not null and v_country <> all(c_allowed_countries) then
        raise log 'hook_before_user_created: blocked non-US signup (country=%)',
          v_country;
        return jsonb_build_object(
          'error', jsonb_build_object(
            'message',   'Diktat is only available in the US right now.',
            'http_code', 403
          )
        );
      end if;
    end if;
  end if;

  return '{}'::jsonb;

exception when others then
  raise warning 'age_block hook soft-fail: % (sqlstate %)', SQLERRM, SQLSTATE;
  return '{}'::jsonb;
end;
$$;

revoke execute on function public.hook_before_user_created(jsonb)
  from public, anon, authenticated;
grant  execute on function public.hook_before_user_created(jsonb)
  to supabase_auth_admin;

comment on function public.hook_before_user_created(jsonb) is
  'Supabase Before-User-Created auth hook. Rejects signup when the '
  'submitted email HMAC exists in public.age_block_tombstones with '
  'expires_at > now(), OR when any identity in event->''user''->'
  '''identities''[] hashes into public.age_block_identity_tombstones, '
  'OR when the client IP at event->''metadata''->>''ip_address'' '
  'resolves via public.geoip_country() to a country that is neither '
  '''US'' nor one of the five permanently inhabited US territories '
  '(PR, GU, VI, AS, MP). Returns the documented '
  '{error:{message,http_code}} envelope on reject and {} on allow. '
  'Null / unlisted / garbage IP = allow (edge-side `x-vercel-ip-country` '
  'check at /api/geo + /auth/callback is the primary enforcement; '
  'this hook is defense-in-depth). FAILS OPEN on any error — missing '
  'pepper, Vault outage, hash fn dropped, geoip_country unavailable: '
  'returns {} and emits a warning. Not SECURITY DEFINER; execute '
  'granted to supabase_auth_admin only.';

commit;
