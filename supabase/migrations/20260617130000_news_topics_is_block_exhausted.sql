-- Migration: add news_topics.is_block_exhausted column
-- Up:   ALTER public.news_topics ADD COLUMN is_block_exhausted boolean
--       NOT NULL DEFAULT false.
-- Down: ALTER public.news_topics DROP COLUMN is_block_exhausted.
--
-- Context:
--   PR #38 (Drop news-sourcing pipeline) produces one news_topics row
--   per ET day. When the 3-consecutive-day cluster-block is exhausted
--   (every active cluster ran for 3 days), drop-publish recycles the
--   highest-ranked cluster anyway — §5 "Never skip a day" wins over
--   the 3-day novelty rule. The selector tracks this as `blockExhausted`
--   and stamps it into scheduled_jobs.payload as job-tick telemetry.
--
--   The Drop UI (PR 4.2) needs the same signal per-row so it can render
--   the §12 disclosure banner ("Slow news week — today's Drop revisits
--   an ongoing story") above the card. job-payload telemetry is the
--   wrong source for a per-row UI render — it's keyed by job id, not
--   topic id, and is meant for the operational audit trail. This adds
--   a parallel boolean on the row that drop-publish stamps at INSERT
--   time alongside the existing payload write.
--
-- Rollback safety:
--   * DROP COLUMN reverses cleanly; only this PR's drop-publish and
--     feed.list reference the column. The existing payload-telemetry
--     stamp at drop-publish.ts:388 stays for operational audit, so the
--     ops audit trail is unaffected by a rollback.
--
-- Backfill:
--   * default false is the correct semantic for the existing dev-DB
--     rows from #38's validation — those Drops were NOT block-exhausted
--     at write time. No backfill UPDATE needed.
--
-- Index:
--   * NONE. The column is row-local: read only when the row's UI
--     renders. No filter or sort against this column is planned.

begin;

alter table public.news_topics
  add column if not exists is_block_exhausted boolean not null default false;

commit;
