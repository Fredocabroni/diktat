-- Migration: shadow-digest timing + Telegram delivery pg_cron entry.
--
-- Shifts the drop_shadow_log generator from 06:00 UTC to 01:10 UTC
-- (= 9:10 PM EDT / 8:10 PM EST) and adds a telegram_digest_send
-- entry at 01:15 UTC (= 9:15 PM EDT / 8:15 PM EST). Both fire
-- shortly after the 8 PM ET Drop; the digest row's drop_date is
-- the America/New_York date of the firing moment, computed in
-- the worker handler.
--
-- Why the ET anchor instead of the UTC 06:00 cadence that
-- 20261103000000 shipped with: the operator reviews the digest
-- within hours of the Drop (same-evening review window), not the
-- next morning. 06 UTC = 1 AM ET post-DST / 2 AM ET pre-DST,
-- which the operator is not awake for.
--
-- Why the migration touches no `cron.unschedule` and no
-- `cron.job` catalog table: `cron.schedule(job_name, schedule,
-- command)` is an UPSERT by job_name. Re-scheduling an existing
-- job with the same name updates its schedule + command in
-- place. That's safe on both:
--   - replay-from-empty (CI "migrations from empty"): the
--     predecessor 20261103000000 creates `drop_shadow_digest`
--     at `0 6 * * *`, then this migration updates it to
--     `10 1 * * *` in the same transaction stream.
--   - existing prod (20261103 already applied, 20261104
--     pending): the schedule in `cron.job` gets updated by
--     name; no catalog ACL friction, no "job not found"
--     exception swallowing.
--
-- Prod max applied at author time: 20261103000000 (drop_shadow_log).
-- This file sorts strictly after.
--
-- Up:
--   select cron.schedule('drop_shadow_digest', '10 1 * * *', ...)
--     — upserts: updates the predecessor's 06:00 UTC entry.
--   select cron.schedule('telegram_digest_send', '15 1 * * *', ...)
--     — new entry.
-- Down (restore 20261103000000's original 06:00 UTC schedule):
--   select cron.schedule('drop_shadow_digest', '0 6 * * *', ...)
--     — upserts the predecessor's schedule back in place.
--   select cron.unschedule('telegram_digest_send');
--     — the send job was first scheduled by THIS migration, so
--     unschedule in the Down path is safe (the job exists).

begin;

-- Reschedule the generator from '0 6 * * *' → '10 1 * * *'. The
-- `cron.schedule` call upserts by job name. Idempotency key stays
-- UTC-based (`YYYY-MM-DD` of now()); the Postgres server runs UTC
-- on hosted Supabase, so at 01:10 UTC the key is the NEW UTC day.
-- The worker computes the digest row's `drop_date` as the
-- America/New_York date of the firing moment (= UTC day − 1), so
-- the row key is the ET date — the operator-facing calendar.
-- The scheduled_jobs idempotency key and the drop_shadow_log PK
-- intentionally use different calendars; the former dedups cron
-- re-fires within a UTC day, the latter is the ET-day review
-- label.

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

-- Telegram delivery cron: 5 minutes after the generator. Same
-- UTC-day idempotency key as every other heat-pipeline cron; the
-- worker handler resolves the drop_shadow_log row to deliver by
-- computing the America/New_York date of the firing moment (NOT
-- the UTC-based idempotency key), matching the generator's row-
-- write calendar documented in the block above.

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
