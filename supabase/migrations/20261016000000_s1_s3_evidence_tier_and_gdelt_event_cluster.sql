-- Migration: S1 + S3 — evidence tiers + outlet balance for GDELT trending
--
-- Operator decisions documented in-chat (2026-10-13):
--
--   S1: three evidence tiers — 'primary' (.gov / courts), 'direct'
--       (reserved for first-party evidence not from .gov; empty today),
--       'reputable' (hand-curated news outlets with AllSides lean +
--       MBFC factual-rating floor Mostly Factual or better).
--
--   S3: a story qualifies for Drop iff (a) it has a primary or direct
--       evidence URL, OR (b) its outlet set spans at least two of
--       {Left, Center, Right} groups (news-type outlets only; the
--       commentary subtype counts for trend_score + the two-group
--       spread signal, but is NEVER the card link).
--
--   Rolling window: a single 15-min GDELT mentions slice rarely shows
--       ≥2 groups covering the same event. We accumulate per
--       GLOBALEVENTID across a 24h rolling window via two new tables.
--
-- Up:
--   enums news_evidence_tier, news_outlet_group, news_outlet_type.
--   (outlet_lean is a text column with a check constraint — AllSides
--   values contain hyphens and we want a cheap drop/replace path if
--   the v9 chart adds a level; see inline comment on the column.)
--   alter public.news_topics_candidates — add evidence_tier (NOT NULL
--     default 'primary'), outlet_lean, outlet_group, outlet_type,
--     global_event_id. default-'primary' is semantically correct for
--     every pre-existing row (congress/bls/sec_edgar are all primary-
--     source adapters).
--   create public.gdelt_event_cluster — one row per GDELT GLOBALEVENTID,
--     carries first/last_seen_at (24h window), best primary URL seen,
--     best paywall-free news URL seen, drop_published_at lifecycle flag.
--   create public.gdelt_event_cluster_outlet — append-only, dedup
--     across ticks via (global_event_id, host) composite PK.
--
-- Down:
--   drop table public.gdelt_event_cluster_outlet;
--   drop table public.gdelt_event_cluster;
--   alter table public.news_topics_candidates
--     drop column evidence_tier,
--     drop column outlet_lean,
--     drop column outlet_group,
--     drop column outlet_type,
--     drop column global_event_id;
--   alter table public.news_topics_candidates
--     drop constraint news_topics_candidates_source_category_check,
--     add constraint news_topics_candidates_source_category_check check (
--       source_category = any (array['congress','fed_economic','bls_labor',
--         'cdc_health','sec_filings','cbo_fiscal','scotus_judicial',
--         'census_demographic','doj_legal','fed_monetary','state_election']::text[])
--     );
--   drop type public.news_outlet_type;
--   drop type public.news_outlet_group;
--   drop type public.news_evidence_tier;
--
-- Follow-ups:
--   * Retention: a 15-min scheduler job (gdelt_event_retention)
--     DELETEs cluster rows where last_seen_at < now() - interval '24h';
--     the outlet table drops via ON DELETE CASCADE. Not pg_cron —
--     wired into the existing in-process scheduler spine.
--   * RLS: both new tables are internal pipeline state. SELECT is
--     granted to authenticated for transparency / UI. INSERT/UPDATE/
--     DELETE have NO policy and no `*_insert_self` — the workers
--     process writes as service_role, which bypasses RLS. This is NOT
--     H3-shaped (no client-driven write path exists; the SECURITY
--     DEFINER RPC pattern only applies when a client could POST
--     directly via PostgREST to the table).
--   * Backward compat: all four new columns on news_topics_candidates
--     are nullable except evidence_tier, which defaults to 'primary'.
--     Code paths that previously inserted without stamping these
--     columns continue to produce valid rows.

-- =========================================================================
-- 1. Enums + source_category widening
-- =========================================================================

create type public.news_evidence_tier as enum ('primary', 'direct', 'reputable');

-- Add 'news' to the source_category check constraint. Reputable-tier
-- candidates (new in this migration) carry source_category='news' —
-- they aren't topically bucketed like the 11 primary adapters are.
-- The structural signal is `evidence_tier`; `source_category` is a
-- secondary field. SOURCE_CATEGORIES in
-- packages/ai-fabric/src/prompts/drop-sources.ts gains 'news' in
-- lockstep. (Postgres has no ALTER CHECK MEMBER, hence drop+recreate.)
alter table public.news_topics_candidates
  drop constraint news_topics_candidates_source_category_check;

alter table public.news_topics_candidates
  add constraint news_topics_candidates_source_category_check check (
    source_category = any (array[
      'congress'::text,
      'fed_economic'::text,
      'bls_labor'::text,
      'cdc_health'::text,
      'sec_filings'::text,
      'cbo_fiscal'::text,
      'scotus_judicial'::text,
      'census_demographic'::text,
      'doj_legal'::text,
      'fed_monetary'::text,
      'state_election'::text,
      'news'::text
    ])
  );

create type public.news_outlet_group as enum ('left', 'center', 'right');

-- AllSides v9's five-level lean rating. We check-constrain outlet_lean
-- rather than use a native enum because the values contain hyphens and
-- a check constraint is cheaper to drop/replace if AllSides adds a
-- level in the future.
--
-- (If AllSides ever adds a new level, the check constraint is updated
-- in a follow-up; the column stays text.)

create type public.news_outlet_type as enum ('news', 'commentary');

-- =========================================================================
-- 2. Alter public.news_topics_candidates — add the four label columns
-- =========================================================================

alter table public.news_topics_candidates
  add column evidence_tier public.news_evidence_tier not null default 'primary',
  add column outlet_lean text,
  add column outlet_group public.news_outlet_group,
  add column outlet_type public.news_outlet_type,
  add column global_event_id text;

alter table public.news_topics_candidates
  add constraint news_topics_candidates_outlet_lean_values check (
    outlet_lean is null
    or outlet_lean in ('left', 'lean-left', 'center', 'lean-right', 'right')
  ) not valid;

alter table public.news_topics_candidates
  validate constraint news_topics_candidates_outlet_lean_values;

-- Reputable rows MUST carry a lean + group + type (the three travel
-- together). Primary/direct rows MUST NOT carry them (nullable).
alter table public.news_topics_candidates
  add constraint news_topics_candidates_outlet_fields_coherent check (
    (
      evidence_tier = 'reputable'
      and outlet_lean is not null
      and outlet_group is not null
      and outlet_type is not null
    )
    or (
      evidence_tier in ('primary', 'direct')
      and outlet_lean is null
      and outlet_group is null
      and outlet_type is null
    )
  ) not valid;

-- NOT VALID + validate on existing rows: default = 'primary' with the
-- three null columns → existing rows already satisfy the coherent-set
-- check. Validate is still fast (single table scan) and guards all
-- future writes.
alter table public.news_topics_candidates
  validate constraint news_topics_candidates_outlet_fields_coherent;

-- global_event_id: GDELT rows only. Index for the join to
-- gdelt_event_cluster at drop-publish time.
create index news_topics_candidates_global_event_id_idx
  on public.news_topics_candidates (global_event_id)
  where global_event_id is not null;

comment on column public.news_topics_candidates.evidence_tier is
  'S1 evidence tier: primary (.gov/courts), direct (first-party, non-.gov), reputable (AllSides-rated news outlet).';
comment on column public.news_topics_candidates.outlet_lean is
  'AllSides v9 lean: left / lean-left / center / lean-right / right. Null for primary/direct rows.';
comment on column public.news_topics_candidates.outlet_group is
  'Derived from outlet_lean per operator spec: left+lean-left → left; center → center; lean-right+right → right. The S3 balance check counts distinct groups per event.';
comment on column public.news_topics_candidates.outlet_type is
  'News vs commentary. Commentary counts for trend_score + the ≥2-group balance signal, but is NEVER the card link on a Drop.';
comment on column public.news_topics_candidates.global_event_id is
  'GDELT GLOBALEVENTID for the mention. Joins to public.gdelt_event_cluster for cross-tick accumulation + S3 balance eligibility.';

-- =========================================================================
-- 3. gdelt_event_cluster — rolling-24h aggregate, one row per GLOBALEVENTID
-- =========================================================================

create table public.gdelt_event_cluster (
  global_event_id text primary key,

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),

  -- Best primary-or-direct URL seen for this event. Nullable until
  -- the first primary/direct mention lands. Once set, holds its first
  -- seen value (no churn — downstream code depends on URL stability
  -- for canonical dedup via news_topics_candidates.dedup_url_canon).
  primary_url text,
  primary_host text,
  primary_tier public.news_evidence_tier,

  -- Best paywall-free news-type URL seen for this event. Preference
  -- order lives in packages/shared/src/news-outlets.ts
  -- (PAYWALL_FREE_PREFERRED_HOSTS). Used as the lazy text-fetch
  -- source for the headline rewrite + fact-explainer at Drop time.
  best_news_url text,
  best_news_host text,

  -- Lifecycle: set when a Drop is published from this cluster. Non-
  -- null → cluster no longer eligible (prevents the same event being
  -- Dropped twice as its last_seen_at keeps refreshing).
  drop_published_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gdelt_event_cluster_primary_tier_coherent check (
    (primary_url is null and primary_host is null and primary_tier is null)
    or (
      primary_url is not null
      and primary_host is not null
      and primary_tier in ('primary', 'direct')
    )
  ),
  constraint gdelt_event_cluster_best_news_coherent check (
    (best_news_url is null and best_news_host is null)
    or (best_news_url is not null and best_news_host is not null)
  )
);

create index gdelt_event_cluster_last_seen_idx
  on public.gdelt_event_cluster (last_seen_at desc);

-- Partial index for the drop-eligible scan: non-null primary_url OR
-- the "two groups news-type" fallback is cheap because the planner
-- walks the outlet table for that check. The non-null-filter here
-- bounds the planner to live rows (drop_published_at IS NULL).
create index gdelt_event_cluster_drop_eligible_idx
  on public.gdelt_event_cluster (last_seen_at desc)
  where drop_published_at is null;

comment on table public.gdelt_event_cluster is
  'Rolling-24h aggregate of GDELT mentions per GLOBALEVENTID. Updated on every ingest tick that sees a mention of the event; retention sweep deletes rows older than 24h via ON DELETE CASCADE on the outlet table.';

-- =========================================================================
-- 4. gdelt_event_cluster_outlet — append-only, dedup across ticks
-- =========================================================================

create table public.gdelt_event_cluster_outlet (
  global_event_id text not null
    references public.gdelt_event_cluster (global_event_id) on delete cascade,
  host text not null,

  -- When the mention is from a reputable outlet, these are populated
  -- from news-outlets.ts via classifyUrl. For primary-tier mentions
  -- (which don't carry lean/group/type), the three columns are null.
  outlet_lean text,
  outlet_group public.news_outlet_group,
  outlet_type public.news_outlet_type,

  url text not null,
  first_seen_at timestamptz not null default now(),

  -- Composite PK: cross-tick dedup is "ON CONFLICT DO NOTHING" on
  -- upsert. Each distinct outlet per event only ever appears once.
  primary key (global_event_id, host),

  constraint gdelt_event_cluster_outlet_lean_values check (
    outlet_lean is null
    or outlet_lean in ('left', 'lean-left', 'center', 'lean-right', 'right')
  ),
  constraint gdelt_event_cluster_outlet_reputable_coherent check (
    -- Reputable mentions carry the full triple (lean + group + type).
    -- Primary/direct mentions have all three null (news-outlets.ts
    -- doesn't rate .gov URLs — classifyUrl returns tier='primary'
    -- with no outlet labels).
    (outlet_lean is not null and outlet_group is not null and outlet_type is not null)
    or (outlet_lean is null and outlet_group is null and outlet_type is null)
  )
);

create index gdelt_event_cluster_outlet_balance_idx
  on public.gdelt_event_cluster_outlet (global_event_id, outlet_group, outlet_type);

comment on table public.gdelt_event_cluster_outlet is
  'Per-outlet detail rows for gdelt_event_cluster. Append-only (composite PK dedups cross-tick re-emits). S3 balance check: count(distinct outlet_group) FILTER (where outlet_type=''news'') per global_event_id.';

-- =========================================================================
-- 5. RLS — internal pipeline tables
-- =========================================================================

alter table public.gdelt_event_cluster enable row level security;
alter table public.gdelt_event_cluster_outlet enable row level security;

-- SELECT: public-read for transparency / UI. Any authenticated user
-- can inspect the per-event aggregate and the outlet detail — the
-- data IS the §2 transparent-math signal (which outlets covered this
-- event, from which groups).
create policy gdelt_event_cluster_select_all
  on public.gdelt_event_cluster
  for select to authenticated using (true);

create policy gdelt_event_cluster_outlet_select_all
  on public.gdelt_event_cluster_outlet
  for select to authenticated using (true);

-- INSERT/UPDATE/DELETE: no policy. The workers process writes as
-- service_role, which bypasses RLS. There is no client-driven write
-- path (no PostgREST POST surface exposed), so no `*_insert_self`
-- policy and no SECURITY DEFINER RPC are needed here. This is NOT
-- H3-shaped — the H3 pattern only applies to tables that have a
-- client-exposed write path.

-- =========================================================================
-- 6. Grants
-- =========================================================================

-- SELECT grants mirror the SELECT policies above. INSERT/UPDATE/DELETE
-- stay with service_role only (default on new tables under the
-- grant-audit regime from migration 20260617160000).
grant select on public.gdelt_event_cluster to authenticated;
grant select on public.gdelt_event_cluster_outlet to authenticated;
