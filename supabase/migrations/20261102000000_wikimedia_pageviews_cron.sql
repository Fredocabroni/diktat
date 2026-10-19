-- Migration: Wikimedia pageviews validation pg_cron entry
--
-- Plan v3 heat-score PR G (recreate off main; supersedes
-- supabase/migrations/20261027000000_wikimedia_pageviews_cron.sql
-- on the closed PR #254 — the old branch went `dirty` against main
-- once 20261024/20261025/20261030/20261101 landed, and its 27
-- timestamp fell below prod max). Schedules
-- `wikimedia_pageviews_validate` daily at 10:00 UTC (safe margin
-- after Wikimedia's ~24h data lag).
--
-- Validation input only, never a primary heat source. The row is
-- consumed by the nightly digest in a follow-up PR to confirm the
-- day's Drop picks correspond to actual public interest. See the
-- handler comment for the latency/terms-of-use rationale.
--
-- No schema change: public.trend_signals already exists (migration
-- 20261023000000, on prod) and 'wikimedia_pageviews' is a value of
-- trend_signal_source.
--
-- Handler gated by WIKIMEDIA_ENABLED=false by default. When off, the
-- handler stamps outcome='disabled' and returns.
--
-- Timestamp rationale (operator decision 2026-10-19): bumped from
-- the originally-queued 20261027 to 20261102. Prod max applied is
-- now 20261101000000 (composer, PR #263); 20261027 fell below prod
-- max and would be rejected by Supabase CLI's db push without
-- --include-all. 20261102 is the next free slot above every
-- merged migration; 20261103 is reserved for the nightly digest
-- recreate (which depends on heat_score from 20261101).
--
-- Prod max applied: 20261101000000. This migration (20261102)
-- sorts strictly after. The cron entry only needs scheduled_jobs
-- + the wikimedia_pageviews enum value, both from predecessors
-- already on main.
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
