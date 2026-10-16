-- Migration: M1 — trend_signals + trend_signals_unmatched
--
-- Operator decisions ("Plan v3 — Heat-score Drop selection", 2026-10-16):
--   V1 heat signal sources = Google Trends RSS + Bluesky trending +
--   X Trends-by-WOEID + Wikimedia pageviews (validate-only). Reddit
--   is DEFERRED pending Reddit Responsible Builder Policy approval;
--   the `reddit` enum value is kept forward-compat here so V1.1 only
--   adds a collector, not a schema migration.
--
-- Design shape:
--   trend_signals is an append-only sink. Each row = one signal from
--   one source, dedup'd per (source, source_id). global_event_id /
--   candidate_id are set by the matcher worker in a follow-up PR
--   (M2 + heat_signal_match); the collector in THIS PR writes rows
--   with both null. match_quality captures how the match was decided
--   (url / token-time / entity) for post-hoc tuning.
--
--   trend_signals_unmatched is the audit sink for rows the matcher
--   failed to attach to a cluster. Same payload shape; separate table
--   keeps the hot path (matched signals → composer) narrow.
--
-- RLS: both tables are internal pipeline state. RLS is enabled but
-- there are NO policies — the workers process writes as service_role
-- (which bypasses RLS), and no `authenticated`/`anon` select is
-- granted. Rationale: (1) ranking inputs are not shown to app users;
-- (2) X trend data arrives in a follow-up PR and X Developer Terms
-- forbid redistributing X content to end users, so an app-visible
-- SELECT path on this table would create a compliance surface we
-- don't want. gdelt_event_cluster is public-readable because the
-- outlet set IS the transparent-math §2 signal rendered on the Drop
-- card; trend_signals is upstream heat scoring, not a user-facing
-- transparency surface. INSERT/UPDATE/DELETE have NO policy and no
-- `*_insert_self` — service_role is the only writer. NOT H3-shaped.
--
-- Retention: 72h sweep. The sweep worker lands in a follow-up PR; this
-- migration does NOT create a retention function or pg_cron entry for
-- the sweep. Rationale: a bounded DELETE in TS matches the
-- gdelt-event-retention.ts pattern already in-tree and avoids a
-- SECURITY DEFINER function that would need its own grant audit.
--
-- Prod max migration version confirmed pre-apply:
--   20261022000000 (gdelt_host_format_checks). This file's
--   20261023000000 sorts strictly after.
--
-- Up:
--   create type trend_signal_source enum.
--   create table public.trend_signals.
--   create table public.trend_signals_unmatched.
--   indexes + unique dedup index on trend_signals.
--   enable RLS; NO policies (service_role writes bypass RLS; no
--     authenticated/anon select — see RLS block below).
--   NO grants to authenticated/anon.
--   pg_cron: google_trends_poll every 15 min (first consumer).
--
-- Down:
--   drop pg_cron entry (`select cron.unschedule('google_trends_poll');`).
--   drop tables (CASCADE drops indexes / enable-RLS state).
--   drop enum.

begin;

-- =========================================================================
-- 1. Enum
-- =========================================================================
--
-- `reddit` is kept forward-compat: Reddit Responsible Builder Policy
-- approval is outstanding. When approval lands, the collector PR
-- inserts rows with source='reddit' without needing a new migration.
-- Removing `reddit` later (if approval is denied) is a trivial
-- `alter type` once no rows reference it.

create type public.trend_signal_source as enum (
  'google_trends',
  'bluesky',
  'x_trends',
  'wikimedia_pageviews',
  'reddit'
);

-- =========================================================================
-- 2. trend_signals — matched signals (hot path)
-- =========================================================================

create table public.trend_signals (
  id uuid primary key default gen_random_uuid(),

  source public.trend_signal_source not null,

  -- Per-source stable identifier. Shapes:
  --   google_trends : the trend title (or stable item guid when the
  --                   RSS feed exposes one — Google's feed does not
  --                   today, so we use the title).
  --   bluesky       : the topic name as returned by
  --                   app.bsky.unspecced.getTrendingTopics.
  --   x_trends      : the trend_name.
  --   wikimedia_pageviews : <project>:<article>:<YYYY-MM-DD>
  --   reddit        : the Reddit post id (t3_<id36>).
  -- Combined with `source` into a unique index below for cross-tick
  -- dedup. Capped length defends against a hostile / mis-encoded feed
  -- blowing out an index page.
  source_id text not null,

  -- Set by the matcher in a follow-up PR. Soft reference — no FK by
  -- design (same rationale as news_topics_candidates.global_event_id
  -- in migration 20261016000000: cluster rows age out at 24h, trend
  -- signals rows age out at 72h, hard FKs would either block retention
  -- or orphan audit rows).
  global_event_id text,

  -- Set by the matcher when a cluster_id → candidate_id resolution is
  -- unambiguous. Null when the matcher only has a global_event_id.
  candidate_id uuid,

  -- Per-source payload. Shape is documented in the collector worker,
  -- not enforced in SQL — jsonb lets different signal shapes coexist
  -- cleanly. Typical fields:
  --   google_trends: { title, approx_traffic, pub_date, news_items[] }
  --   bluesky:       { topic, display_name, description, link }
  --   x_trends:      { trend_name, tweet_volume? }
  --   reddit:        { title, selftext, subreddit, score, upvote_ratio,
  --                     num_comments, created_utc, url, permalink }
  --   wikimedia_pageviews: { project, article, views, rank, date }
  --   degrade shape: { degraded: true, reason }
  payload jsonb not null default '{}'::jsonb,

  -- Set by the matcher. Shape: { method: 'url'|'token_time'|'entity',
  -- shared_tokens?: int, time_delta_minutes?: int, score: numeric }.
  match_quality jsonb,

  created_at timestamptz not null default now(),

  constraint trend_signals_source_id_length check (char_length(source_id) between 1 and 512)
);

-- Cross-tick dedup. Same signal arriving on a later poll tick updates
-- nothing — we treat the first observation as canonical (matches the
-- gdelt_event_cluster "first-seen wins" pattern). The collector worker
-- does `on conflict do nothing`.
create unique index trend_signals_source_source_id_idx
  on public.trend_signals (source, source_id);

create index trend_signals_source_created_idx
  on public.trend_signals (source, created_at desc);

create index trend_signals_global_event_idx
  on public.trend_signals (global_event_id)
  where global_event_id is not null;

create index trend_signals_candidate_idx
  on public.trend_signals (candidate_id)
  where candidate_id is not null;

-- Retention sweep index. The follow-up retention worker will
-- DELETE WHERE created_at < now() - interval '72 hours'. A plain
-- btree on created_at is enough; the partial-index tricks in use
-- elsewhere don't help here (retention sees every row by definition).
create index trend_signals_created_at_idx
  on public.trend_signals (created_at);

comment on table public.trend_signals is
  'Append-only heat-signal sink. One row per distinct (source, source_id) observation. The matcher worker (follow-up PR) sets global_event_id + candidate_id when the signal attaches to a GDELT cluster.';
comment on column public.trend_signals.payload is
  'Per-source raw payload. Shape documented in each collector worker; validated by the composer when the signal is read. Null-safe default so a collector that only knows its source + source_id can still write a presence row.';
comment on column public.trend_signals.match_quality is
  'Matcher provenance. {method, shared_tokens?, time_delta_minutes?, score}. Null until the matcher processes the row.';

-- =========================================================================
-- 3. trend_signals_unmatched — audit sink for the matcher
-- =========================================================================

create table public.trend_signals_unmatched (
  id uuid primary key default gen_random_uuid(),

  source public.trend_signal_source not null,
  source_id text not null,

  -- Full payload at the time matching gave up. Same shape as
  -- trend_signals.payload.
  payload jsonb not null default '{}'::jsonb,

  -- Why the matcher couldn't attach it. Free-text, bounded. Typical:
  -- 'no_cluster_url_match', 'token_overlap_below_threshold',
  -- 'time_window_miss', 'entity_overlap_below_threshold'.
  reason text,

  created_at timestamptz not null default now(),

  constraint trend_signals_unmatched_source_id_length
    check (char_length(source_id) between 1 and 512),
  constraint trend_signals_unmatched_reason_length
    check (reason is null or char_length(reason) between 1 and 128)
);

create index trend_signals_unmatched_source_created_idx
  on public.trend_signals_unmatched (source, created_at desc);

create index trend_signals_unmatched_created_at_idx
  on public.trend_signals_unmatched (created_at);

comment on table public.trend_signals_unmatched is
  'Audit sink for signals the matcher failed to attach to a GDELT cluster. Not on the hot path; read ad-hoc by the operator-review digest to calibrate matcher thresholds. Same 72h retention as trend_signals.';

-- =========================================================================
-- 4. RLS — no policies, no app-visible SELECT
-- =========================================================================
--
-- RLS is enabled; NO policies are created. service_role bypasses RLS
-- and is the only writer; authenticated/anon have no SELECT grant and
-- no policy, so a RLS traversal from a user JWT returns zero rows.
--
-- Why this diverges from gdelt_event_cluster (which IS public-readable):
--   - gdelt_event_cluster is the §2 transparent-math surface rendered
--     on the Drop card. Users need to see which outlets covered a
--     story.
--   - trend_signals is upstream heat-score input. It is NOT shown to
--     users and should not be queryable by them.
--   - X trend data (follow-up PR) carries X Developer Terms
--     obligations against redistributing to end users; an app-visible
--     SELECT on this table would create a compliance surface we
--     don't want.

alter table public.trend_signals enable row level security;
alter table public.trend_signals_unmatched enable row level security;

-- No grants to authenticated/anon.

-- =========================================================================
-- 5. pg_cron — google_trends_poll (first consumer)
-- =========================================================================
--
-- Every 15 minutes. One row per tick; the handler fetches the Google
-- Trends RSS feed (geo=US), parses, and writes rows into trend_signals.
-- idempotency_key is the wall-clock minute (same shape as
-- news_ingest_poll / news_dedup_rank_run from 20260616120000).
--
-- No corresponding Bluesky / X / Wikimedia / Reddit cron entries are
-- added here — each lands with its own PR (per the Plan v3 build
-- sequence). This cron entry is the only one for M1.

select cron.schedule(
  'google_trends_poll',
  '*/15 * * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key, payload)
    values (
      'google_trends_poll',
      to_char(now(), 'YYYY-MM-DD HH24:MI'),
      jsonb_build_object('emitted_at', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
    )
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

commit;
