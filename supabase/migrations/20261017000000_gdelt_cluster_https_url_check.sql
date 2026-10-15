-- Migration: #214 security condition 1 — https-URL CHECK constraints on
-- gdelt_event_cluster.primary_url and gdelt_event_cluster_outlet.url.
--
-- Operator decision 2026-10-14 (PR #214 push-5 security-reviewer
-- "PASS with conditions"): add defense-in-depth CHECK constraints so
-- a future write path that bypasses `classifyUrl` / `requireHttpsUrl`
-- cannot land a non-https URL in either column. Today the only
-- writer is the SECURITY DEFINER RPC `upsert_gdelt_event_mention`,
-- which receives URLs post-classifyUrl + post-requireHttpsUrl
-- (storage-boundary scheme assertion in workers' GDELT sink). The
-- CHECK constraint is a last-mile guarantee at the storage layer.
--
-- Prod violation count (read-only pre-apply SELECT 2026-10-14):
--   gdelt_event_cluster.primary_url:        0 non-https / 541 rows (all null today — no primary-tier GDELT mentions have landed yet)
--   gdelt_event_cluster_outlet.url:         0 non-https / 548 rows
-- Zero violations, so validation is immediate (not NOT VALID).
--
-- Up:
--   add constraint gdelt_event_cluster_primary_url_https on
--     gdelt_event_cluster: primary_url IS NULL OR starts with 'https://'
--     (primary_url is nullable until the first primary/direct mention
--     lands; the NULL branch preserves the pre-existing semantics).
--   add constraint gdelt_event_cluster_outlet_url_https on
--     gdelt_event_cluster_outlet: url starts with 'https://'
--     (url is NOT NULL, no null branch needed).
--
-- Down:
--   alter table public.gdelt_event_cluster_outlet
--     drop constraint if exists gdelt_event_cluster_outlet_url_https;
--   alter table public.gdelt_event_cluster
--     drop constraint if exists gdelt_event_cluster_primary_url_https;
--
-- NOT TOUCHED by this migration (deliberately scoped to operator spec):
--   * gdelt_event_cluster.best_news_url — same column shape as
--     primary_url (nullable, SSRF-sensitive). Operator-scoped to the
--     two columns above; `best_news_url` can be added in a follow-up
--     if the drop-publish integration surfaces a need for symmetry.
--   * news_topics_candidates.source_url — the pre-existing primary
--     evidence URL column. #218 tracks related hardening on
--     news-ingest.ts.
--
-- Also folded (necessary for #214 push-5 security condition 3,
-- "remove the `as any` on the upsert_gdelt_event_mention RPC call
-- using the generated types"): `create or replace function
-- public.upsert_gdelt_event_mention` adds `default null` to the
-- three outlet args and `default false` to the paywall-free flag.
-- Postgres function args without an explicit default are typed as
-- strictly non-null by Supabase's gen-types, which forces the
-- TypeScript caller back to an `as any` cast when it needs to pass
-- null for primary-tier mentions (where outlet_lean/group/type are
-- intentionally absent). Marking the args `default null` makes
-- gen-types emit them as optional, so the TypeScript boundary can
-- cleanly type the RPC call. Behavior-neutral — the function body
-- is unchanged.

begin;

-- =========================================================================
-- 1. gdelt_event_cluster.primary_url
-- =========================================================================

alter table public.gdelt_event_cluster
  add constraint gdelt_event_cluster_primary_url_https check (
    primary_url is null or primary_url like 'https://%'
  );

comment on constraint gdelt_event_cluster_primary_url_https
  on public.gdelt_event_cluster is
  'Defense-in-depth: no non-https URL can land in primary_url even if a future writer bypasses workers requireHttpsUrl. PR #214 push-5 security-reviewer condition 1.';

-- =========================================================================
-- 2. gdelt_event_cluster_outlet.url
-- =========================================================================

alter table public.gdelt_event_cluster_outlet
  add constraint gdelt_event_cluster_outlet_url_https check (
    url like 'https://%'
  );

comment on constraint gdelt_event_cluster_outlet_url_https
  on public.gdelt_event_cluster_outlet is
  'Defense-in-depth: no non-https URL can land in url even if a future writer bypasses workers requireHttpsUrl. PR #214 push-5 security-reviewer condition 1.';

-- =========================================================================
-- 3. upsert_gdelt_event_mention — add default null on the three outlet
--    args (and default false on the paywall-free flag) so Supabase gen-
--    types emits them as optional, enabling the TypeScript boundary to
--    drop its `as any` cast. Function BODY is unchanged.
-- =========================================================================

create or replace function public.upsert_gdelt_event_mention(
  p_global_event_id text,
  p_url text,
  p_host text,
  p_evidence_tier public.news_evidence_tier,
  p_outlet_lean text default null,
  p_outlet_group public.news_outlet_group default null,
  p_outlet_type public.news_outlet_type default null,
  p_is_paywall_free_preferred boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_primary boolean := p_evidence_tier in ('primary', 'direct');
  v_is_paywall_free_news boolean := p_is_paywall_free_preferred and p_outlet_type = 'news';
begin
  -- Step 1 — cluster row upsert with first-seen-wins coalesce.
  insert into public.gdelt_event_cluster as c (
    global_event_id,
    first_seen_at,
    last_seen_at,
    updated_at,
    primary_url,
    primary_host,
    primary_tier,
    best_news_url,
    best_news_host
  ) values (
    p_global_event_id,
    now(),
    now(),
    now(),
    case when v_is_primary then p_url else null end,
    case when v_is_primary then p_host else null end,
    case when v_is_primary then p_evidence_tier else null end,
    case when v_is_paywall_free_news then p_url else null end,
    case when v_is_paywall_free_news then p_host else null end
  )
  on conflict (global_event_id) do update set
    last_seen_at = excluded.last_seen_at,
    updated_at = excluded.updated_at,
    primary_url = coalesce(c.primary_url, excluded.primary_url),
    primary_host = coalesce(c.primary_host, excluded.primary_host),
    primary_tier = coalesce(c.primary_tier, excluded.primary_tier),
    best_news_url = coalesce(c.best_news_url, excluded.best_news_url),
    best_news_host = coalesce(c.best_news_host, excluded.best_news_host);

  -- Step 2 — outlet row insert, cross-tick dedup via composite PK.
  insert into public.gdelt_event_cluster_outlet (
    global_event_id,
    host,
    outlet_lean,
    outlet_group,
    outlet_type,
    url
  ) values (
    p_global_event_id,
    p_host,
    p_outlet_lean,
    p_outlet_group,
    p_outlet_type,
    p_url
  )
  on conflict (global_event_id, host) do nothing;
end;
$$;

-- Re-apply the grant posture. The function was created with SECURITY
-- DEFINER + revoke-from-public + grant-to-service-role in migration
-- 20261016000000; `create or replace` preserves owner + ACL but we
-- re-run the revoke/grant pair here explicitly to make the grant
-- boundary readable in this migration.
revoke all on function public.upsert_gdelt_event_mention(
  text, text, text, public.news_evidence_tier, text,
  public.news_outlet_group, public.news_outlet_type, boolean
) from public;

grant execute on function public.upsert_gdelt_event_mention(
  text, text, text, public.news_evidence_tier, text,
  public.news_outlet_group, public.news_outlet_type, boolean
) to service_role;

commit;
