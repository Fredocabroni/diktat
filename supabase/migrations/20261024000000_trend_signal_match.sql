-- Migration: M2 — trend_signal matcher — indexes + unmatched dedup + pg_cron
--
-- Operator decision ("Plan v3 — Heat-score Drop selection"): V1 heat
-- signals (Google Trends, Bluesky, X, Wikimedia) land in
-- public.trend_signals (migration 20261023000000). They are not
-- useful until each row is linked to the GDELT event cluster the
-- signal is about. The matcher worker in apps/workers/src/jobs/heat/
-- match.ts does that link.
--
-- This migration is index-only + pg_cron. The matcher worker is pure
-- TypeScript; no SECURITY DEFINER RPC or schema change on
-- trend_signals / trend_signals_unmatched is required beyond:
--
--   1. A partial index for the matcher's hot scan — "unattached rows
--      in the last 72h". trend_signals.global_event_id is populated
--      sparsely (NULL until the matcher attaches it), and the
--      matcher runs every 15 min against the full null-slice.
--   2. A unique index on trend_signals_unmatched (source, source_id)
--      so the matcher's "give-up" INSERT is idempotent across ticks.
--      #247 schema-reviewer flagged this as a LOW: without it, a
--      signal that never matches would stack a duplicate audit row
--      every tick for the 72h retention window.
--
-- Prod max migration version confirmed pre-apply: 20261023000000
-- (trend_signals). This file's 20261024000000 sorts strictly after.
--
-- Up:
--   create partial index trend_signals_unattached_idx.
--   create unique index trend_signals_unmatched_source_source_id_idx.
--   pg_cron: heat_signal_match every 15 min.
--
-- Down (strict reversal order):
--   select cron.unschedule('heat_signal_match');
--   drop index public.trend_signals_unmatched_source_source_id_idx;
--   drop index public.trend_signals_unattached_idx;

begin;

-- =========================================================================
-- 1. Partial index — matcher hot scan on unattached rows
-- =========================================================================
--
-- The matcher's primary query shape:
--   select id, source, source_id, payload, created_at
--     from public.trend_signals
--    where global_event_id is null
--      and created_at > now() - interval '72 hours'
--    order by created_at asc
--    limit 500;
--
-- Partial index excludes the (eventually) majority of rows that have
-- been matched. Index size stays O(unattached backlog) rather than
-- O(72h of signals). Same shape as trend_signals_global_event_idx
-- (where global_event_id is not null) but inverted.

create index trend_signals_unattached_idx
  on public.trend_signals (created_at desc)
  where global_event_id is null;

-- =========================================================================
-- 2. Unique index — idempotent give-up insert into unmatched sink
-- =========================================================================
--
-- The matcher's give-up path (signal older than 1h without a match)
-- upserts a row into trend_signals_unmatched using ON CONFLICT DO
-- NOTHING on (source, source_id). Without this unique index, the
-- upsert would stack duplicates on every tick until the retention
-- sweep aged the signal out. Closes #247 schema-reviewer LOW:
-- "trend_signals_unmatched has no dedup unique."

create unique index trend_signals_unmatched_source_source_id_idx
  on public.trend_signals_unmatched (source, source_id);

-- =========================================================================
-- 3. pg_cron — heat_signal_match every 15 min
-- =========================================================================
--
-- Same idempotency shape as news_ingest_poll / google_trends_poll:
-- idempotency_key is the wall-clock minute (distinct per */15 tick).
-- No cron entry here for Bluesky/X/Wikimedia collectors — each
-- lands with its own PR per the plan v3 build sequence.

select cron.schedule(
  'heat_signal_match',
  '*/15 * * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key, payload)
    values (
      'heat_signal_match',
      to_char(now(), 'YYYY-MM-DD HH24:MI'),
      jsonb_build_object('emitted_at', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
    )
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

commit;
