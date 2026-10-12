-- Migration: tighten news_topics_candidates.trend_score CHECK with an
-- upper bound.
-- Up:   drop the existing `trend_score IS NULL OR trend_score >= 0`
--       constraint, replace with `trend_score IS NULL OR
--       (trend_score BETWEEN 0 AND 10000)`.
-- Down: drop the new constraint, restore the original non-negative CHECK.
--
-- Design context (security-reviewer PR #201 round 3 LOW 5.2):
--   The initial CHECK on 20261014000000 enforced non-negativity only.
--   `GDELT_MAX_ARTICLES = 500` and `GDELT_MIN_TREND_SCORE = 2` bound
--   trend_score in practice to [2, 500], but those are JS runtime
--   limits — not DB invariants. A future change to the article cap
--   OR a direct psql insert bypassing the adapter would land values
--   outside the business range.
--
--   Upper bound of 10_000 is well above the realistic trending signal
--   (even an extremely viral story rarely crosses ~1,000 distinct
--   primary-source outlets) while catching obvious off-by-orders-of-
--   magnitude bugs (e.g. a future refactor accidentally stamping an
--   article count instead of an outlet count, or an unsigned int32
--   value that overflowed to billions).
--
-- Timestamp 20261015000000: next free day in the operator-reserved
-- range after 20261014000000.
--
-- Lock profile.
--   Both `DROP CONSTRAINT` and `ADD CONSTRAINT ... NOT VALID` are
--   catalog-only. `VALIDATE CONSTRAINT` scans existing rows: at
--   current prod scale (<1k rows in news_topics_candidates) the scan
--   is sub-millisecond. The ACCESS EXCLUSIVE lock held through the
--   full transaction is acceptable at this scale (same reasoning as
--   20261012010000 + 20261013100000 + 20261014000000).

begin;

alter table public.news_topics_candidates
  drop constraint if exists news_topics_candidates_trend_score_nonneg;

alter table public.news_topics_candidates
  add constraint news_topics_candidates_trend_score_range check (
    trend_score is null or (trend_score between 0 and 10000)
  ) not valid;

alter table public.news_topics_candidates
  validate constraint news_topics_candidates_trend_score_range;

commit;

-- ---------------------------------------------------------------------------
-- Down (reference, not auto-run):
--   alter table public.news_topics_candidates
--     drop constraint if exists news_topics_candidates_trend_score_range;
--   alter table public.news_topics_candidates
--     add constraint news_topics_candidates_trend_score_nonneg check (
--       trend_score is null or trend_score >= 0
--     );
