-- Migration: sweep_go_live
--
-- Up: flip the `data_minimization_sweep_daily` pg_cron job's payload
--     from {dry_run: true} to {dry_run: false}. Operator allowlist
--     (public.sweep_protected_users) is populated in prod, and the
--     pre-launch branch of public.data_minimization_sweep is still
--     date-gated to run only after 2026-11-20 (migration
--     20261114000000 lines 224-227), so flipping the payload today is
--     safe. The age-blocked purge branch becomes effective the moment
--     this migration applies; the pre-launch purge branch activates
--     per its own clock gate.
--
--     pg_cron's `cron.schedule(jobname, schedule, command)` UPSERTS by
--     jobname — when a job with the same name already exists for the
--     current role, its schedule and command are updated in place. We
--     therefore re-run the same call with the SAME jobname and SAME
--     schedule as 20261113000000, only the embedded payload JSON
--     changes. No `cron.unschedule` needed.
--
-- Down: re-run the same call with {dry_run: true}.
--   select cron.schedule(
--     'data_minimization_sweep_daily',
--     '0 3 * * *',
--     $cron$
--       insert into public.scheduled_jobs (job_type, idempotency_key, payload)
--       values (
--         'data_minimization_sweep',
--         to_char(now(), 'YYYY-MM-DD'),
--         jsonb_build_object('dry_run', true)
--       )
--       on conflict (job_type, idempotency_key) where target_user_id is null
--       do nothing;
--     $cron$
--   );

begin;

select cron.schedule(
  'data_minimization_sweep_daily',
  '0 3 * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key, payload)
    values (
      'data_minimization_sweep',
      to_char(now(), 'YYYY-MM-DD'),
      jsonb_build_object('dry_run', false)
    )
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

commit;
