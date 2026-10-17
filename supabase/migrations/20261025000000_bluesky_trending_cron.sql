-- Migration: Bluesky trending collector pg_cron entry
--
-- Plan v3 heat-score Drop selection, PR E. Schedules the
-- `bluesky_trending_poll` scheduler-spine job every 15 min. The
-- handler (apps/workers/src/jobs/heat/bluesky-poll.ts) is gated by
-- BLUESKY_ENABLED=false by default — rows the cron emits while the
-- flag is off are stamped `outcome='disabled'` and done, so the
-- queue drains cleanly without producing heat signals.
--
-- No schema changes. public.trend_signals and
-- public.trend_signals_unmatched already exist (migration
-- 20261023000000). The Bluesky signal uses source='bluesky' —
-- already a value of public.trend_signal_source.
--
-- Prod max applied: 20261023000000 (trend_signals, M1). This
-- migration (20261025) sorts strictly after. Note: 20261024
-- (matcher indexes + cron) is a sibling PR not yet merged — the
-- Supabase CLI treats missing-timestamp gaps as non-blocking, and
-- when 20261024 lands it sorts between prod max and this file by
-- the normal migration-order contract.
--
-- Up: cron.schedule('bluesky_trending_poll', '*/15 * * * *', ...)
-- Down: select cron.unschedule('bluesky_trending_poll');

begin;

select cron.schedule(
  'bluesky_trending_poll',
  '*/15 * * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key, payload)
    values (
      'bluesky_trending_poll',
      to_char(now(), 'YYYY-MM-DD HH24:MI'),
      jsonb_build_object('emitted_at', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
    )
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

commit;
