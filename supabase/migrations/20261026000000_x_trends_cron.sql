-- Migration: X Trends-by-WOEID collector pg_cron entry
--
-- Plan v3 heat-score PR F. Schedules `x_trends_poll` hourly (not
-- 15-min like Google/Bluesky — the X API charges per request;
-- see apps/workers/src/jobs/heat/x-trends-poll.ts cost note).
--
-- No schema change: public.trend_signals already exists (migration
-- 20261023000000) and 'x_trends' is a value of trend_signal_source.
--
-- Handler gated by X_TRENDS_ENABLED=false by default. When off, the
-- handler stamps outcome='disabled' and returns without fetching.
-- No live X API call tonight; fixtures only (per operator rules).
--
-- Prod max applied: 20261023000000 (trend_signals, M1). This
-- migration (20261026) sorts strictly after. 20261024 (matcher) +
-- 20261025 (Bluesky cron) are sibling PRs that may or may not be
-- merged ahead of this one; neither is a hard dependency of this
-- file (the cron entry only needs scheduled_jobs + the x_trends
-- enum value, both from predecessors already on main).
--
-- Up: cron.schedule('x_trends_poll', '0 * * * *', ...)
-- Down: select cron.unschedule('x_trends_poll');

begin;

select cron.schedule(
  'x_trends_poll',
  '0 * * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key, payload)
    values (
      'x_trends_poll',
      to_char(now(), 'YYYY-MM-DD HH24'),
      jsonb_build_object('emitted_at', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
    )
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

commit;
