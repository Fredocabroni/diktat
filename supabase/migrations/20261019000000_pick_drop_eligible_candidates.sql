-- Migration: PR C — enforce S3 outlet-balance in SQL.
--
-- Operator spec (2026-10-14 overnight brief):
--   Returns active Drop-eligible candidates per two rules:
--     (1) selected_at null AND rejected_reason null AND
--         dedup_cluster_id not null AND rank_score not null
--     (2) evidence_tier in ('primary','direct')
--         OR (evidence_tier='reputable'
--             AND gdelt_event_cluster has
--               >=2 distinct hosts
--               >=2 distinct outlet_groups
--               >=1 outlet_type='news'
--             AND gdelt_event_cluster.drop_published_at is null)
--
-- Commentary semantics (operator decision pending):
--   Commentary outlets COUNT toward 2-host / 2-group spread
--     (they are legitimate cluster coverage, just not evidence-grade links).
--   Commentary is NEVER the Drop LINK — enforced in drop-publish.ts
--     when it picks the news-type URL to fetch and attach as
--     primary_source_url (see PR C's TS changes to drop-publish.ts).
--   WHETHER commentary-outlet CANDIDATES (news_topics_candidates rows
--     where outlet_type='commentary') appear in the eligibility list
--     is controlled by `p_commentary_as_drop_candidate`, default FALSE
--     per operator spec. If the operator ships commentary-driven Drops,
--     flip this default in a follow-up migration — the toggle is NAMED
--     here (one-line flip) to make the operator decision explicit.
--
-- Prod max migration version confirmed read-only pre-apply:
--   `select max(version) from supabase_migrations.schema_migrations;`
--   → 20261018000000. New migration 20261019000000 sorts strictly after.
--
-- Grants: SECURITY DEFINER, search_path=''. REVOKE from public +
-- anon + authenticated; GRANT EXECUTE to service_role only. The workers
-- process is the sole caller (via drop-publish.ts).
--
-- Up:
--   create or replace function public.pick_drop_eligible_candidates(
--     p_commentary_as_drop_candidate boolean default false
--   ) returns table (...) language sql security definer set search_path='' as $$ ... $$;
--   revoke all on function ... from public, anon, authenticated;
--   grant execute on function ... to service_role;
--
--   create or replace function public.stamp_cluster_drop_published(
--     p_global_event_id text,
--     p_at timestamptz default now()
--   ) returns boolean language plpgsql security definer set search_path='' as $$ ... $$;
--   revoke / grant as above.
--
-- Down:
--   drop function if exists public.stamp_cluster_drop_published(text, timestamptz);
--   drop function if exists public.pick_drop_eligible_candidates(boolean);

begin;

-- =========================================================================
-- 1. pick_drop_eligible_candidates — the S3 enforcement RPC.
-- =========================================================================

create or replace function public.pick_drop_eligible_candidates(
  p_commentary_as_drop_candidate boolean default false
)
returns table (
  id uuid,
  source_provider text,
  source_category text,
  source_title text,
  source_url text,
  source_host text,
  source_published_at timestamptz,
  summary text,
  dedup_cluster_id uuid,
  rank_score numeric,
  evidence_tier public.news_evidence_tier,
  outlet_type public.news_outlet_type,
  global_event_id text
)
language sql
security definer
set search_path = ''
as $$
  with cluster_shape as (
    select o.global_event_id,
           count(distinct o.host) as distinct_hosts,
           count(distinct o.outlet_group) filter (where o.outlet_group is not null) as distinct_groups,
           count(*) filter (where o.outlet_type = 'news'::public.news_outlet_type) as news_type_count
      from public.gdelt_event_cluster_outlet o
      group by o.global_event_id
  )
  select ntc.id,
         ntc.source_provider,
         ntc.source_category,
         ntc.source_title,
         ntc.source_url,
         ntc.source_host,
         ntc.source_published_at,
         ntc.summary,
         ntc.dedup_cluster_id,
         ntc.rank_score,
         ntc.evidence_tier,
         ntc.outlet_type,
         ntc.global_event_id
    from public.news_topics_candidates ntc
    left join cluster_shape cs on cs.global_event_id = ntc.global_event_id
    left join public.gdelt_event_cluster c on c.global_event_id = ntc.global_event_id
    where ntc.selected_at is null
      and ntc.rejected_reason is null
      and ntc.dedup_cluster_id is not null
      and ntc.rank_score is not null
      -- Commentary-as-candidate gate: default false → commentary rows
      -- never appear as the Drop candidate. One-line operator flip.
      and (
        p_commentary_as_drop_candidate
        or ntc.outlet_type is distinct from 'commentary'::public.news_outlet_type
      )
      -- Tier eligibility: primary/direct bypass S3; reputable must pass
      -- the cluster outlet-balance rule AND the cluster must not have
      -- already been Drop-published.
      and (
        ntc.evidence_tier in (
          'primary'::public.news_evidence_tier,
          'direct'::public.news_evidence_tier
        )
        or (
          ntc.evidence_tier = 'reputable'::public.news_evidence_tier
          and ntc.global_event_id is not null
          and cs.distinct_hosts >= 2
          and cs.distinct_groups >= 2
          and cs.news_type_count >= 1
          and c.drop_published_at is null
        )
      )
    order by ntc.rank_score desc nulls last, ntc.id;
$$;

revoke all on function public.pick_drop_eligible_candidates(boolean) from public;
revoke all on function public.pick_drop_eligible_candidates(boolean) from anon;
revoke all on function public.pick_drop_eligible_candidates(boolean) from authenticated;
grant execute on function public.pick_drop_eligible_candidates(boolean) to service_role;

comment on function public.pick_drop_eligible_candidates(boolean) is
  'S3 enforcement for Drops: returns active-ranked candidates where either (a) evidence_tier in (primary,direct), or (b) evidence_tier=reputable AND the GDELT cluster has >=2 distinct hosts from >=2 distinct outlet_groups AND >=1 news-type outlet AND cluster.drop_published_at is null. Commentary outlets count toward 2-host/2-group spread. p_commentary_as_drop_candidate controls whether commentary-outlet CANDIDATES appear in the list (default false per operator spec, pending). PR C.';

-- =========================================================================
-- 2. stamp_cluster_drop_published — atomic cluster-stamp helper.
-- =========================================================================

create or replace function public.stamp_cluster_drop_published(
  p_global_event_id text,
  p_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated int;
begin
  update public.gdelt_event_cluster
    set drop_published_at = p_at,
        updated_at = now()
    where global_event_id = p_global_event_id
      and drop_published_at is null;
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end$$;

revoke all on function public.stamp_cluster_drop_published(text, timestamptz) from public;
revoke all on function public.stamp_cluster_drop_published(text, timestamptz) from anon;
revoke all on function public.stamp_cluster_drop_published(text, timestamptz) from authenticated;
grant execute on function public.stamp_cluster_drop_published(text, timestamptz) to service_role;

comment on function public.stamp_cluster_drop_published(text, timestamptz) is
  'Mark a gdelt_event_cluster row as Drop-published if it has not already been. Returns true if the row was updated, false if the cluster was not found or already stamped (idempotent). Called by drop-publish.ts after a successful reputable-tier Drop. PR C.';

commit;
