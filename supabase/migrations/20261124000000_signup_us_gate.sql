-- Migration: signup_us_gate
--
-- US gate 2/2. PR 1/2 (migration 20261123000000) shipped the
-- public.geoip_country_blocks table + public.geoip_country(inet) lookup.
-- This PR wires the lookup into public.hook_before_user_created so a
-- non-US client IP is refused at Supabase Auth's Before-User-Created
-- hook, BEFORE an auth.users row (and the provisioning trigger chain)
-- is created.
--
-- Up:
--   create or replace public.hook_before_user_created(jsonb) with the
--   existing 20261120000000 body kept byte-for-byte (tombstone email +
--   identity checks + fail-open outer exception handler) plus, AFTER
--   the tombstone checks, a country check:
--
--     * Read the client IP from event->'metadata'->>'ip_address'
--       (the documented Before-User-Created hook payload shape).
--       Source of truth: the `BeforeUserCreatedInput` + `Metadata`
--       Go structs in `internal/hooks/v0hooks/v0hooks.go` in
--       https://github.com/supabase/auth — the payload envelope is
--       `{metadata, user}` and `Metadata.IPAddress` carries the tag
--       `json:"ip_address,omitempty"`. Public docs page:
--       https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook
--       (payload example shows `metadata.ip_address`). The field is
--       `omitempty`, so admin-API creations (no request IP) send an
--       empty / missing value — we must tolerate both. The value is
--       always a single plain IP string (IPv4 or IPv6), never a CIDR
--       and never an XFF chain: `getIPAddressWithXFF` in auth splits
--       the XFF header and emits only `parsed.String()` of the first
--       parseable entry.
--     * Cast to inet inside an inner exception block so a malformed
--       string (anything that fails `::inet`) is treated the same
--       as "no IP present" → ALLOW. This keeps a bad payload from
--       tripping the outer fail-open handler (which would also
--       allow, but with a noisy warning).
--     * If the cast succeeds AND `public.geoip_country(ip)` returns
--       a non-null value AND that value is not 'US', return the
--       same `{error:{message,http_code:403}}` envelope the
--       tombstone rejects use. The reject message is:
--         'Diktat is only available in the US right now.'
--     * NULL country (IP not covered by any GeoLite block) → ALLOW.
--     * On reject, emit exactly one `raise log` line naming ONLY
--       the ISO country code. Never log the IP or the email —
--       the hook has fail-open operator logging for the HMAC/age
--       surface and we do not want to accumulate an "attempted
--       non-US signups" PII side-channel here.
--
--   The outer fail-open exception handler is unchanged — anything
--   that escapes the inner IP-parse block (e.g. geoip_country raising,
--   the function being dropped, the table being inaccessible) still
--   logs the pre-existing soft-fail warning and returns '{}'. The
--   country gate is defense-in-depth on top of the edge-side
--   `x-vercel-ip-country` check at /api/geo + /auth/callback; a
--   runtime failure of the gate should NOT block signups — the
--   edge check remains the first line.
--
-- Access posture: unchanged — the hook function already has
-- `revoke execute from public, anon, authenticated` + `grant execute
-- to supabase_auth_admin` from 20261120000000, and supabase_auth_admin
-- already holds EXECUTE on public.geoip_country(inet) via 20261123000000.
--
-- Down:
--   create or replace function public.hook_before_user_created back to
--   the 20261120000000 body (the entire country block above, plus its
--   raise-log line and inner exception block, is removed; the email
--   + identity + outer fail-open paths remain).

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

  -- (b) Identity path. Iterate event->'user'->'identities'[]. Shape at
  -- pre-create is undocumented in the Supabase docs; when the array
  -- is empty or missing this loop is a no-op, and the sweep-written
  -- identity tombstone remains the line of defense on repeat-attempt
  -- purges. This body is forward-compatible with Supabase populating
  -- the array without a code change.
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

  -- (c) Country path. Runs AFTER the tombstone checks so a tombstoned
  -- principal is rejected first even when the country lookup would
  -- also pass (US tombstoned signup → the email/identity reject with
  -- its specific message, not the country message).
  --
  -- Edge/callback already enforces US-only on `x-vercel-ip-country`;
  -- this hook is defense-in-depth against a signup that reaches the
  -- auth API from a path that bypassed those checks (e.g. a direct
  -- call from a non-browser client).
  v_ip_text := event -> 'metadata' ->> 'ip_address';
  if v_ip_text is not null and btrim(v_ip_text) <> '' then
    -- Inner exception block scoped to the ::inet cast only. A
    -- malformed string ("::", "garbage", "1.2.3", a CIDR with a
    -- weird mask) raises invalid_text_representation; we catch it
    -- here and treat as "no IP" → fall through to allow. Keeping
    -- this handler inside its own BEGIN/END stops the outer
    -- fail-open handler from firing on a payload-shape issue,
    -- which would log a noisy warning for a condition we expect
    -- to tolerate.
    begin
      v_ip := v_ip_text::inet;
    exception when others then
      v_ip := null;
    end;

    if v_ip is not null then
      v_country := public.geoip_country(v_ip);
      -- NULL country = IP not covered by any GeoLite block → ALLOW.
      -- Unknown is treated the same as "probably US" here; the edge
      -- check is the stronger signal and already fired.
      if v_country is not null and v_country <> 'US' then
        -- Operator signal. Country code ONLY. No IP, no email.
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
  -- Fail-open guard. Covers: missing pepper (P0001 from
  -- _age_block_hash), Vault outage, hash function dropped, bad
  -- payload shape, anything else. Operators monitor the Postgres
  -- warning stream for soft-fails.
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
  'resolves via public.geoip_country() to a country other than ''US''. '
  'Returns the documented {error:{message,http_code}} envelope on '
  'reject and {} on allow. Null / unlisted / garbage IP = allow '
  '(edge-side `x-vercel-ip-country` check at /api/geo + /auth/callback '
  'is the primary US-only enforcement; this hook is defense-in-depth). '
  'FAILS OPEN on any error — missing pepper, Vault outage, hash fn '
  'dropped, geoip_country unavailable: returns {} and emits a '
  'warning. Not SECURITY DEFINER; execute granted to '
  'supabase_auth_admin only.';

commit;
