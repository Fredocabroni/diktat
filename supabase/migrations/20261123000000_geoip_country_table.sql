-- Migration: geoip_country_table
--
-- Up:
--   (1) table public.geoip_country_blocks — maps a CIDR network to its
--       ISO-3166-1 alpha-2 country code. Populated by the monthly
--       .github/workflows/geoip-refresh.yml loader from the MaxMind
--       GeoLite2-Country CSV (IPv4 + IPv6 Blocks joined to Locations,
--       with a geoname_id -> registered_country_geoname_id fallback).
--       Per-tick refresh is one-shot: `truncate + copy` inside a single
--       transaction, so the table is never visible partially-loaded.
--   (2) GiST index on (network inet_ops) so containment lookups
--       (`network >>= ip`) scan an interval tree, not a seq-scan over
--       ~550k rows.
--   (3) public.geoip_country(ip inet) — returns the ISO code of the
--       most-specific CIDR containing `ip`, NULL when no row matches.
--       SECURITY INVOKER (NOT security definer; the function is callable
--       by supabase_auth_admin via the explicit SELECT policy and by
--       service_role via BYPASSRLS), language sql stable,
--       `set search_path = ''`.
--
-- Access posture (same shape as the tombstone tables):
--   * RLS enabled, zero user-facing policies.
--   * `revoke all` from public, anon, authenticated.
--   * `grant select` + explicit `for select to supabase_auth_admin
--     using (true)` policy — belt-and-braces against a future drop of
--     BYPASSRLS on that role (precedent: migration
--     20261121000000_tombstone_auth_admin_select_policy).
--   * service_role continues to bypass RLS platform-side and retains
--     default public-schema grants (INSERT/TRUNCATE/UPDATE/DELETE) so
--     the monthly loader can rewrite the table in one transaction.
--
-- Downstream consumer:
--   PR 2 of 2 adds a geoip_country() check inside
--   hook_before_user_created. This migration is data-shape only.
--
-- Down:
--   drop function if exists public.geoip_country(inet);
--   drop index  if exists public.geoip_country_blocks_network_gist;
--   drop table  if exists public.geoip_country_blocks;

begin;

create table public.geoip_country_blocks (
  network     cidr    primary key,
  country_iso char(2) not null
);

alter table public.geoip_country_blocks enable row level security;

-- Default Postgres grants on a new public-schema table in Supabase can
-- hand SELECT to anon/authenticated (depending on default-privileges
-- configuration). Revoke proactively so the only principals with any
-- access are supabase_auth_admin (SELECT via the policy below) and
-- service_role (BYPASSRLS + default grants, needed for the monthly
-- truncate/copy loader).
revoke all on public.geoip_country_blocks from public, anon, authenticated;

grant select on public.geoip_country_blocks to supabase_auth_admin;

create policy geoip_country_blocks_select_auth_admin
  on public.geoip_country_blocks
  for select
  to supabase_auth_admin
  using (true);

-- GiST index enabling O(log n) containment lookups `network >>= ip`.
-- `inet_ops` is the core Postgres opclass for GiST on cidr/inet and
-- supports the containment-left (<<, <<=) and containment-right (>>,
-- >>=) operators the geoip_country() function relies on.
create index geoip_country_blocks_network_gist
  on public.geoip_country_blocks
  using gist (network inet_ops);

comment on table public.geoip_country_blocks is
  'IPv4 + IPv6 → ISO-3166-1 alpha-2 country code, from the MaxMind '
  'GeoLite2-Country CSV. Loaded monthly by '
  '.github/workflows/geoip-refresh.yml (truncate + copy in one '
  'transaction). RLS on, no policies; supabase_auth_admin has SELECT '
  'via the policy below, service_role bypasses RLS.';

comment on column public.geoip_country_blocks.network is
  'CIDR network from GeoLite2 Blocks files (IPv4 + IPv6). Primary key.';

comment on column public.geoip_country_blocks.country_iso is
  'ISO-3166-1 alpha-2 of the Location row joined on geoname_id, with '
  'a fallback to registered_country_geoname_id when geoname_id is '
  'null (MaxMind documents this pattern for stateless-proxy ranges).';

-- --------------------------------------------------------------------
-- geoip_country(inet) — most-specific-CIDR lookup. Returns null when
-- no row contains the input IP. NOT SECURITY DEFINER; runs as invoker.
-- --------------------------------------------------------------------
create or replace function public.geoip_country(ip inet)
returns text
language sql
stable
set search_path = ''
as $$
  select country_iso::text
    from public.geoip_country_blocks
   where network >>= ip
   order by masklen(network) desc
   limit 1
$$;

revoke execute on function public.geoip_country(inet)
  from public, anon, authenticated;

grant execute on function public.geoip_country(inet)
  to supabase_auth_admin, service_role;

comment on function public.geoip_country(inet) is
  'Return the ISO-3166-1 alpha-2 country code of the MOST-SPECIFIC '
  'CIDR in public.geoip_country_blocks that contains the given IP, or '
  'NULL when no row matches. SECURITY INVOKER (not definer); callable '
  'by supabase_auth_admin (via the geoip_country_blocks SELECT policy) '
  'and service_role (via BYPASSRLS). `set search_path = ''''` so '
  'resolution does not depend on the caller''s search_path.';

commit;
