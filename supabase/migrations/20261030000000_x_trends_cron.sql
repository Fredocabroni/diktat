-- Migration: X Trends-by-WOEID collector pg_cron entry
--
-- Plan v3 heat-score PR F (recreate off main; supersedes
-- supabase/migrations/20261026000000_x_trends_cron.sql on the
-- closed PR #253 — never merged). Schedules `x_trends_poll` hourly
-- (not 15-min like Google/Bluesky — the X API charges per request;
-- see apps/workers/src/jobs/heat/x-trends-poll.ts cost note).
--
-- No schema change: public.trend_signals already exists (migration
-- 20261023000000, on prod) and 'x_trends' is a value of
-- trend_signal_source.
--
-- Handler gated by X_TRENDS_ENABLED=false by default. When off, the
-- handler stamps outcome='disabled' and returns without fetching.
-- No live X API call tonight; fixtures only (per operator rules).
--
-- Timestamp rationale (operator decision 2026-10-18): bumped from
-- the originally-queued 20261026 to 20261030 because #255's
-- 20261028 (composer) and #256's 20261029 (shadow digest) are
-- queued to land first. Supabase CLI's `db push` refuses out-of-
-- order application without --include-all; renumbering before
-- merge is cheap, renumbering after a merge-and-apply-attempt is
-- a loud failure.
--
-- Prod max applied: 20261025000000 (Bluesky cron, PR #259). This
-- migration (20261030) sorts strictly after. Nothing in this file
-- depends on 20261028 or 20261029 — the cron entry only needs
-- scheduled_jobs + the x_trends enum value.
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
