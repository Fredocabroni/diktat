-- Migration: add trend_score column to news_topics_candidates.
-- Up:   add a nullable `trend_score integer` column + CHECK ensuring the
--       value is non-negative when non-null. news-dedup-rank will read
--       this column in a follow-up PR to bias rank_score for trending-
--       source adapters (GDELT today, Grok X-search + Reddit later).
-- Down: drop column public.news_topics_candidates.trend_score;
--
-- Design context (security-reviewer PR #201 LOW):
--   The GDELT adapter in `apps/workers/src/jobs/news-ingest.ts` currently
--   encodes the trend score as a `[trend=N] ...` prefix on the free-text
--   `summary` column so no migration was required for #201. Reviewer
--   flagged this: (a) the prefix leaks the internal signal to any
--   downstream consumer that renders `summary`, (b) a regex-reparse on
--   write-side-only data is a brittle contract. This column makes
--   trend_score a first-class scoring input.
--
--   Timestamp 20261014000000: operator-reserved per the overnight-run
--   brief. The `20261013*` range is reserved for A6 and GDELT; A6's
--   migration already lives at 20261013100000. The 20261014000000 slot
--   is clean of A6 collisions and clean of the trending-sources
--   follow-up migrations proposed in docs/phase-5/trending-sources-
--   2026-10-11.md (which use 20261013010000/020000/030000).
--
-- Shape rationale.
--   - Nullable. RSS adapters (Congress / BLS / SEC EDGAR) don't
--     produce a trending signal; a non-null default would misrepresent
--     their candidates.
--   - CHECK trend_score >= 0 when non-null. A distinct-outlet count is
--     by definition non-negative; the CHECK keeps a direct psql insert
--     from stamping a negative value that the ranker might treat as
--     "subtract from rank_score".
--   - No index at this step. news-dedup-rank reads trend_score as part
--     of a per-candidate scoring pass, not via a bounded range scan.
--     If a future scoring job needs an index, add it in that PR.
--
-- Lock profile.
--   `ADD COLUMN` on a nullable column with no default is a catalog-only
--   change — PostgreSQL does not rewrite the heap. ACCESS EXCLUSIVE for
--   O(ms). CHECK constraint added as NOT VALID + VALIDATE in two
--   statements inside the same transaction (same acceptable-trade-off
--   pattern as 20261012010000 and 20261013100000; news_topics_candidates
--   is <10k rows at launch; sub-second scan).

begin;

alter table public.news_topics_candidates
  add column trend_score integer;

alter table public.news_topics_candidates
  add constraint news_topics_candidates_trend_score_nonneg check (
    trend_score is null or trend_score >= 0
  ) not valid;

alter table public.news_topics_candidates
  validate constraint news_topics_candidates_trend_score_nonneg;

comment on column public.news_topics_candidates.trend_score is
  'Distinct-outlet count for the cluster that produced this candidate '
  'at ingest time. Non-null for trending-source adapters (GDELT today, '
  'Grok X-search + Reddit later); null for primary-source RSS adapters. '
  'news-dedup-rank biases rank_score on this value in the trending-score '
  'follow-up PR (see docs/phase-5/trending-sources-2026-10-11.md).';

commit;

-- ---------------------------------------------------------------------------
-- Down (reference, not auto-run):
--   alter table public.news_topics_candidates
--     drop constraint if exists news_topics_candidates_trend_score_nonneg;
--   alter table public.news_topics_candidates
--     drop column if exists trend_score;
