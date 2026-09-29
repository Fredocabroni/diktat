-- Migration: pg_cron entry that enqueues invariant_check rows.
--
-- Companion to PR #126's handler
-- (apps/workers/src/jobs/invariant-check.ts) — the handler was registered
-- in workers boot and ships gated on `job_type = 'invariant_check'` rows
-- landing in public.scheduled_jobs. This migration is what puts them there.
--
-- Cadence: every 15 minutes, aligned with the existing news_ingest_poll /
-- news_dedup_rank_run spine (20260616120000_drop_pipeline.sql:226-256).
-- One enqueue per tick per check_name (currently two checks). The handler
-- filters by `payload.check_name` and runs exactly one check per row.
--
-- Idempotency: the key is prefixed by job_type + check_name to keep the
-- (job_type, idempotency_key) unique-index partition self-describing on
-- a raw select from scheduled_jobs. `on conflict ... do nothing` swallows
-- an accidental cron double-fire at the same minute bucket.
--
-- `cron.schedule` upserts by NAME (`invariant_check_run` here), so re-
-- running this migration is a no-op on the scheduler entry.
--
-- Up:   create the cron entry.
-- Down: reference at the bottom (delete rows first for FK-cascade hygiene,
--       then cron.unschedule).

begin;

-- One cron entry, two enqueues per tick — one row per check_name. The
-- handler at apps/workers/src/jobs/invariant-check.ts:284+ reads
-- payload.check_name and calls `runInvariantChecks({only: [name]})`.
--
-- payload.emitted_at is included the same way news_ingest_poll includes it
-- (20260616120000_drop_pipeline.sql:234) — a wall-clock breadcrumb useful
-- for reconciling scheduler lag against the cron tick.
select cron.schedule(
  'invariant_check_run',
  '*/15 * * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key, payload)
    values
      (
        'invariant_check',
        'invariant_check:battle_settled_missing_ap:' || to_char(now(), 'YYYY-MM-DD HH24:MI'),
        jsonb_build_object(
          'check_name', 'battle_settled_missing_ap',
          'emitted_at', to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
        )
      ),
      (
        'invariant_check',
        'invariant_check:prediction_missing_stake:' || to_char(now(), 'YYYY-MM-DD HH24:MI'),
        jsonb_build_object(
          'check_name', 'prediction_missing_stake',
          'emitted_at', to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
        )
      )
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

commit;

-- Down (reference, not auto-run):
--   begin;
--   -- unschedule the cron entry (idempotent — unschedule by name).
--   select cron.unschedule('invariant_check_run');
--   -- drain any in-flight rows. Handler self-alerts on connection error,
--   -- so a deleted-mid-flight row will surface as an error alert on the
--   -- next tick and go quiet after that.
--   delete from public.scheduled_jobs
--     where job_type = 'invariant_check'
--       and status in ('pending', 'processing');
--   commit;
