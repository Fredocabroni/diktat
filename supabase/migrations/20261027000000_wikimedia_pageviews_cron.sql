-- Migration: Wikimedia pageviews validation pg_cron entry
--
-- Plan v3 heat-score PR G. Schedules `wikimedia_pageviews_validate`
-- daily at 10:00 UTC (safe margin after Wikimedia's ~24h data lag).
--
-- Validation input only, never a primary heat source. The row is
-- consumed by the nightly digest in a follow-up PR to confirm the
-- day's Drop picks correspond to actual public interest. See the
-- handler comment for the latency/terms-of-use rationale.
--
-- No schema change: public.trend_signals already exists (migration
-- 20261023000000) and 'wikimedia_pageviews' is a value of
-- trend_signal_source.
--
-- Handler gated by WIKIMEDIA_ENABLED=false by default. When off, the
-- handler stamps outcome='disabled' and returns.
--
-- Prod max applied: 20261023000000 (trend_signals, M1). This
-- migration (20261027) sorts strictly after. 20261024 (matcher) +
-- 20261025 (Bluesky cron) + 20261026 (X cron) are sibling PRs that
-- may or may not be merged ahead of this one; none is a hard
-- dependency of this file (the cron entry only needs scheduled_jobs
-- + the wikimedia_pageviews enum value, both from predecessors
-- already on main).
--
-- Up: cron.schedule('wikimedia_pageviews_validate', '0 10 * * *', ...)
-- Down: select cron.unschedule('wikimedia_pageviews_validate');

begin;

select cron.schedule(
  'wikimedia_pageviews_validate',
  '0 10 * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key, payload)
    values (
      'wikimedia_pageviews_validate',
      to_char(now(), 'YYYY-MM-DD'),
      jsonb_build_object('emitted_at', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
    )
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

commit;
