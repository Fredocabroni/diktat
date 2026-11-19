-- Migration: lopsided_drop_check
--
-- Adds a "not much of a debate" operator alert for Drops that lock
-- lopsided. Triggered when a Drop has >=20 locked opinion_shifts AND
-- one side holds >=85% of the total. One Telegram note per Drop,
-- deduped by news_topics.lopsided_alert_sent_at.
--
-- Up:
--   1. New column public.news_topics.lopsided_alert_sent_at timestamptz.
--      NULL = not alerted. Stamped by the handler after a successful
--      Telegram send.
--   2. pg_cron entry `lopsided_drop_check` — every 30 minutes, inserts
--      one `lopsided_drop_check` scheduled_jobs row for each published
--      Drop in the last 48h that has not yet been alerted. The handler
--      filters again on the current stance split (20 locked / 85%)
--      and sends the Telegram note.
--
-- Down: unschedule the cron entry; drop the column.

begin;

alter table public.news_topics
  add column if not exists lopsided_alert_sent_at timestamptz;

comment on column public.news_topics.lopsided_alert_sent_at is
  'Timestamp of the "not much of a debate" operator Telegram note '
  'for this Drop. NULL = not alerted. Stamped by the '
  'lopsided_drop_check worker handler after a successful send; '
  'guarantees one note per Drop.';

-- Partial index: narrows the re-check scan to recent, un-alerted,
-- published Drops. The handler walks this set every 30 minutes.
create index if not exists news_topics_lopsided_pending_idx
  on public.news_topics (published_at desc)
  where published = true
    and lopsided_alert_sent_at is null;

select cron.schedule(
  'lopsided_drop_check',
  '*/30 * * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key, payload)
    select
      'lopsided_drop_check',
      -- One row per (topic, 30-min bucket). The handler either sends
      -- and stamps lopsided_alert_sent_at (next tick: topic no longer
      -- matches the WHERE) or re-checks and no-ops (next tick: new
      -- bucket, tries again). Caps queue depth even if the handler is
      -- paused for a day.
      t.id::text || ':' || to_char(date_trunc('minute', now()), 'YYYY-MM-DD HH24:MI'),
      jsonb_build_object(
        'topic_id', t.id,
        'drop_date', t.drop_date,
        'enqueued_at', now()
      )
    from public.news_topics t
    where t.published = true
      and t.lopsided_alert_sent_at is null
      and t.published_at >= now() - interval '48 hours'
      and t.is_drop = true
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

commit;
