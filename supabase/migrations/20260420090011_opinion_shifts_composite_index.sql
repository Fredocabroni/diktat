-- Migration: composite index on opinion_shifts for the feed activity loop
-- Up:   add (user_id, topic_id, created_at desc) to support
--       "this user's recent shifts on this topic" lookups (used by the
--       feed's de-dupe / change-of-mind detection) without dropping
--       the existing single-column indexes.
-- Down: drop the composite index.

begin;

create index if not exists opinion_shifts_user_topic_created_idx
  on public.opinion_shifts (user_id, topic_id, created_at desc);

commit;

-- Down (reference, not auto-run):
--   drop index if exists public.opinion_shifts_user_topic_created_idx;
