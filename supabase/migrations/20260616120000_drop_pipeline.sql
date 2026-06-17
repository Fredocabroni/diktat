-- Migration: drop_pipeline — upstream news-sourcing infrastructure for The
-- Drop (PR 4.2 consumer). Three layers:
--   1. Staging table for in-flight candidates ingested from primary
--      sources (Congress.gov, BLS, SCOTUS in V1).
--   2. ALTERs on public.news_topics to carry the verbatim source title
--      (alongside the Diktat-voice headline), the cluster id (for the
--      3-consecutive-day repeat block), the curation_mode telemetry
--      (which path produced this Drop), and additional_sources for
--      framing context.
--   3. pg_cron entries that emit news_ingest (*/15) and news_dedup_rank
--      (*/30) scheduled_jobs rows. The existing drop_due_check cron
--      (PR #25) already emits the 20:00 ET drop_publish row.
--
-- Up:
--   - create public.news_topics_candidates (staging)
--   - alter public.news_topics add source_title, additional_sources,
--     dedup_cluster_id, curation_mode
--   - cron.schedule news_ingest_poll + news_dedup_rank_run
--
-- Down (reference, not auto-run):
--   select cron.unschedule('news_ingest_poll');
--   select cron.unschedule('news_dedup_rank_run');
--   drop index if exists public.news_topics_dedup_cluster_id_idx;
--   alter table public.news_topics
--     drop column if exists curation_mode,
--     drop column if exists dedup_cluster_id,
--     drop column if exists additional_sources,
--     drop column if exists source_title;
--   drop table if exists public.news_topics_candidates;
--
-- Design context (full scope in plan):
--   * The host-allow-list / ban-list is CODE, not schema (lives in
--     packages/ai-fabric/src/prompts/drop-sources.ts). Migration enforces
--     enum constraints on source_category to keep the eleven V1 buckets
--     authoritative at the DB layer; the host classifier sits at the
--     ingest boundary.
--   * dedup_cluster_id on news_topics (NOT a FK to candidates) — the
--     candidate row may be aged out by retention; the UUID is a grouping
--     key, not a row-pointer. The 3-day cluster block reads this column.
--   * curation_mode is observability. V1 ships only auto_dominant +
--     auto_fallback_no_channel paths (no curator channel wired yet);
--     auto_fallback_timeout + curator_selected come online when the
--     curator notification channel ships in a follow-up.
--   * Retention: news_topics_candidates grows monotonically. For V1
--     volume (~50-100 candidates/day across 3 sources), no cleanup job
--     is needed in the first 3 months. Manual sweep:
--       delete from public.news_topics_candidates
--       where created_at < now() - interval '7 days'
--             and (selected_at is not null or rejected_reason is not null);
--     A retention cron is a v2 polish item.
--   * RLS: enabled, no policies on news_topics_candidates. Internal
--     staging table. Service-role only — mirrors scheduled_jobs.

begin;

-- ---------------------------------------------------------------------------
-- 1) news_topics_candidates — staging for in-flight ingestion
-- ---------------------------------------------------------------------------

create table public.news_topics_candidates (
  id                    uuid primary key default gen_random_uuid(),
  -- Which adapter produced this row. Free-text; the code-side adapter
  -- registry is the source of truth for valid values (V1: 'congress',
  -- 'bls', 'scotus'). Stored verbatim for diagnostics.
  source_provider       text not null,
  -- One of the eleven V1 source-derived category buckets. CHECK
  -- constraint here is the schema-side guard; the code-side enum in
  -- packages/ai-fabric/src/prompts/drop-sources.ts must stay in sync.
  source_category       text not null check (source_category in (
    'congress',
    'fed_economic',
    'bls_labor',
    'cdc_health',
    'sec_filings',
    'cbo_fiscal',
    'scotus_judicial',
    'census_demographic',
    'doj_legal',
    'fed_monetary',
    'state_election'
  )),
  -- Verbatim title from the source feed (preserved for source_title on
  -- the eventual news_topics row).
  source_title          text not null,
  -- The URL the source feed pointed at. Host-allow-listed at ingest
  -- time — never a ban-list host (the §1 contract). Always primary.
  source_url            text not null,
  -- Normalized host (lowercased, www-stripped) for ranking weight by
  -- primary-source diversity.
  source_host           text not null,
  -- When the source published the item. Drives recency_decay in
  -- the ranker.
  source_published_at   timestamptz,
  -- Optional short summary from the source feed (RSS <description>).
  summary               text,
  -- URL canonicalization: lowercased host + path with tracking params
  -- stripped. Cheap first-pass dedup key — same canon = same URL.
  dedup_url_canon       text not null,
  -- Assigned by the news_dedup_rank handler. Multiple candidates with
  -- the same cluster_id are different sources covering the same story.
  -- News_topics row that becomes the Drop carries this id forward for
  -- the 3-day repeat block.
  dedup_cluster_id      uuid,
  -- Assigned by the news_dedup_rank handler.
  -- = primary_source_density × gdelt_trending_velocity × recency_decay.
  -- gdelt_trending_velocity is 1.0 in V1 until the GDELT adapter lands.
  rank_score            numeric,
  -- Stamped when the drop_publish handler promotes this candidate to
  -- the day's news_topics row. NULL means the candidate is still in
  -- the running pool (or was aged out).
  selected_at           timestamptz,
  -- Stamped when the host-allow-list rejects the URL, or when the row
  -- is older than the candidate window. NULL means active. Cheap
  -- diagnostic — keeps rejected rows visible in the table for audit
  -- rather than silently dropping them on the floor.
  rejected_reason       text check (rejected_reason is null or rejected_reason in (
    'host_not_allowed',
    'duplicate',
    'stale',
    'invalid_payload'
  )),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- Idempotency on (provider, url) so re-ingesting a feed doesn't
  -- duplicate rows. The same URL from a different provider IS allowed
  -- (different framing, same underlying primary source).
  unique (source_provider, source_url)
);

-- For per-provider polling (most-recent-first scans).
create index news_topics_candidates_provider_created_idx
  on public.news_topics_candidates (source_provider, created_at desc);

-- For URL-canon dedup lookups.
create index news_topics_candidates_url_canon_idx
  on public.news_topics_candidates (dedup_url_canon);

-- For ranker's top-N pick — active candidates only, ordered by rank.
create index news_topics_candidates_active_rank_idx
  on public.news_topics_candidates (rank_score desc nulls last)
  where selected_at is null and rejected_reason is null;

-- For the dedup phase's cluster-membership scan.
create index news_topics_candidates_cluster_idx
  on public.news_topics_candidates (dedup_cluster_id)
  where dedup_cluster_id is not null;

create trigger news_topics_candidates_set_updated_at
  before update on public.news_topics_candidates
  for each row execute function public.set_updated_at();

alter table public.news_topics_candidates enable row level security;

-- Belt-and-suspenders: revoke client roles' default privileges, mirror
-- of scheduled_jobs. Internal table; service-role only.
revoke all on public.news_topics_candidates from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) ALTERs on public.news_topics
-- ---------------------------------------------------------------------------

-- Verbatim source title preserved alongside the Diktat-voice headline.
-- Always populated when the row was produced by the drop_publish handler;
-- nullable to keep backward compat with any seeded test rows.
alter table public.news_topics
  add column if not exists source_title text;

-- Framing context — secondary URLs (may include ban-list MSM hosts as
-- FRAMING, never as primary truth). Shape: jsonb array of
-- { url: text, host: text, role: 'framing' | 'primary_supplementary' }.
-- Default '[]' keeps existing rows valid. The typeof CHECK is the
-- schema-side belt-and-suspenders against a write that lands a non-array
-- shape (the app layer also zod-validates, but the column is also read
-- by future surfaces — this contract should be defended at the DB).
alter table public.news_topics
  add column if not exists additional_sources jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'news_topics_additional_sources_is_array'
  ) then
    alter table public.news_topics
      add constraint news_topics_additional_sources_is_array
      check (jsonb_typeof(additional_sources) = 'array');
  end if;
end $$;

-- Grouping key for the 3-consecutive-day repeat block. Same cluster
-- cannot become the Drop on day+1 or day+2 either. INTENTIONALLY NOT
-- A FK: cluster_id is a grouping token, not a row-pointer to
-- news_topics_candidates. The candidate row may be aged out by
-- retention (manual sweep documented in header); a FK would break.
-- Future "tighten foreign keys" sweeps should leave this column alone.
alter table public.news_topics
  add column if not exists dedup_cluster_id uuid;

-- Telemetry — which path produced this Drop. V1 ships auto_dominant
-- and auto_fallback_no_channel only. The remaining values come online
-- when the curator notification channel ships in a follow-up.
alter table public.news_topics
  add column if not exists curation_mode text check (curation_mode is null or curation_mode in (
    'auto_dominant',
    'auto_fallback_no_channel',
    'auto_fallback_timeout',
    'curator_selected'
  ));

-- 3-day repeat block scan: "find any Drop whose cluster appears within
-- last N days". Partial index keeps it small.
create index if not exists news_topics_dedup_cluster_id_idx
  on public.news_topics (dedup_cluster_id)
  where dedup_cluster_id is not null;

-- ---------------------------------------------------------------------------
-- 3) pg_cron entries
-- ---------------------------------------------------------------------------
-- cron.schedule is idempotent by name (upsert on re-run).

-- news_ingest_poll — every 15 minutes. One row per tick; the handler
-- iterates configured source adapters and writes candidates into
-- news_topics_candidates. ON CONFLICT DO NOTHING defends against
-- accidental cron double-fires; idempotency_key is the wall-clock
-- minute (distinct per */15 tick).
select cron.schedule(
  'news_ingest_poll',
  '*/15 * * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key, payload)
    values (
      'news_ingest',
      to_char(now(), 'YYYY-MM-DD HH24:MI'),
      jsonb_build_object('emitted_at', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
    )
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

-- news_dedup_rank_run — every 30 minutes. Clusters and scores the
-- active candidate pool. Same idempotency shape as ingest.
select cron.schedule(
  'news_dedup_rank_run',
  '*/30 * * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key, payload)
    values (
      'news_dedup_rank',
      to_char(now(), 'YYYY-MM-DD HH24:MI'),
      jsonb_build_object('emitted_at', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
    )
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

commit;
