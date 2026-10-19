-- Migration: telegram_digest_send pg_cron entry (shadow-only delivery).
--
-- Enqueues a scheduled_jobs row daily at 06:05 UTC — 5 minutes after
-- the drop_shadow_digest generator (0 6 * * *, migration
-- 20261103000000) writes the day's row. The worker handler reads the
-- latest drop_shadow_log row, formats a top-5 inline-keyboard message
-- and posts it to Telegram via the operator chat. The long-poll loop
-- processes callback_query button clicks and writes the operator's
-- pick back through record_drop_shadow_operator_pick.
--
-- TELEGRAM_DIGEST_ENABLED gates the handler at the worker level; the
-- cron keeps firing even when the flag is off so the queue drains
-- cleanly (stamp outcome='disabled' and return — same pattern as
-- every other heat-pipeline cron).
--
-- Prod max applied at author time: 20261103000000 (drop_shadow_log).
-- This file sorts strictly after.
--
-- Up: cron.schedule('telegram_digest_send', '5 6 * * *', ...)
-- Down: select cron.unschedule('telegram_digest_send');

begin;

-- 5 past the hour so the generator (0 6 * * *) has reliably landed
-- its row by the time we read drop_shadow_log. The idempotency key
-- is the UTC day so a re-fire within the same day is a no-op.

select cron.schedule(
  'telegram_digest_send',
  '5 6 * * *',
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
