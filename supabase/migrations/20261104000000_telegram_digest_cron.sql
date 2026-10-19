-- Migration: shadow-digest timing + Telegram delivery pg_cron entry.
--
-- Shifts the drop_shadow_log generator from 06:00 UTC to 01:10 UTC
-- (= 9:10 PM EDT / 8:10 PM EST) and adds a telegram_digest_send
-- entry at 01:15 UTC (= 9:15 PM EDT / 8:15 PM EST). Both fire
-- shortly after the 8 PM ET Drop; the digest row's drop_date is
-- the ET date of tonight's Drop, computed in the worker handler.
--
-- Why the ET anchor instead of the UTC 06:00 cadence that
-- 20261103000000 shipped with: the operator reviews the digest
-- within hours of the Drop (same-evening review window), not the
-- next morning. 05 UTC = 1 AM ET post-DST / 2 AM ET pre-DST, which
-- the operator is not awake for.
--
-- The timing shift uses `cron.unschedule` + `cron.schedule`
-- because the applied 20261103000000 row cannot be edited in
-- place from a new migration — rescheduling by job name is the
-- supported pattern. `cron.schedule` itself upserts by name, so
-- the unschedule+schedule pair is explicit about intent.
--
-- Prod max applied at author time: 20261103000000 (drop_shadow_log).
-- This file sorts strictly after.
--
-- Up:
--   select cron.unschedule('drop_shadow_digest');
--   select cron.schedule('drop_shadow_digest', '10 1 * * *', ...)
--   select cron.schedule('telegram_digest_send', '15 1 * * *', ...)
-- Down (restore 20261103000000's original 06:00 UTC schedule):
--   select cron.unschedule('telegram_digest_send');
--   select cron.unschedule('drop_shadow_digest');
--   select cron.schedule('drop_shadow_digest', '0 6 * * *', ...)

begin;

-- Reschedule the generator from '0 6 * * *' → '10 1 * * *'.
-- Idempotency key stays UTC-based (`YYYY-MM-DD` of now()); the
-- Postgres server runs UTC on hosted Supabase, so at 01:10 UTC
-- the key is the NEW UTC day. The worker computes the digest row's
-- `drop_date` as the America/New_York date of the firing moment,
-- so the row key is the ET date (= the previous UTC day). The
-- scheduled_jobs idempotency key and the drop_shadow_log PK
-- intentionally use different calendars; the former dedups cron
-- re-fires within a UTC day, the latter is the ET-day review
-- label the operator reads.

select cron.unschedule('drop_shadow_digest');

select cron.schedule(
  'drop_shadow_digest',
  '10 1 * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key, payload)
    values (
      'drop_shadow_digest',
      to_char(now(), 'YYYY-MM-DD'),
      jsonb_build_object('emitted_at', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
    )
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

-- Telegram delivery cron: 5 minutes after the generator (same
-- UTC-day idempotency key as every other heat-pipeline cron).

select cron.schedule(
  'telegram_digest_send',
  '15 1 * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key, payload)
    values (
      'telegram_digest_send',
      to_char(now(), 'YYYY-MM-DD'),
      jsonb_build_object('emitted_at', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
    )
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

commit;
