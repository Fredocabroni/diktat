-- Migration: fact_explainer defense-in-depth constraints (PR #198 fast-follow).
-- Up:   Add CHECK constraint on news_topics.fact_explainer enforcing posture
--       enum + for_summary presence + https-only source_url. Narrow the
--       news_topics_fact_explainer_pending_idx partial index to exclude
--       retracted / pre-publication rows (drop_at IS NOT NULL).
-- Down: drop the CHECK constraint; restore the pre-fold index body.
--
-- Design context (fast-follow to #198, operator-live-with-67-users premise):
--   The initial A4 migration 20261012000000 landed via #198 before the
--   security-reviewer HIGH fixes could be folded. The reviewer flagged:
--     * HIGH #2 — non-https source_url is a stored XSS vector when
--       DropCard renders it inside an anchor. Zod + parseFactExplainer
--       guards landed as code in this fast-follow PR, but a direct psql
--       session or future misconfigured worker could bypass both.
--     * MEDIUM #1 — no DB-level shape / posture / scheme guard.
--     * LOW — the pending-explainer partial index covers retracted rows.
--
--   The already-applied 20261012000000 cannot be modified. This migration
--   layers the CHECK + narrowed index on top.
--
-- Note on existing data: the CHECK is non-strict (fact_explainer IS NULL
-- is permitted). Any pre-existing non-null rows must already match the
-- shape — the Zod schema the drop-publish handler enforced at write
-- time guarantees this. If a direct-psql write landed a non-conforming
-- row between the two migrations, ADD CONSTRAINT fails and the migration
-- rolls back cleanly; the fix is to clean up the bad row and re-apply.
--
-- Validation surface: covered via the unit tests on FactExplainerSchema
-- in apps/workers/__tests__/jobs/drop-publish.test.ts and the
-- parseFactExplainer read-time guards in apps/api/__tests__/routers/feed.test.ts.

begin;

alter table public.news_topics
  add constraint news_topics_fact_explainer_shape check (
    fact_explainer is null or (
      jsonb_typeof(fact_explainer) = 'object'
      and fact_explainer ? 'posture'
      and (fact_explainer->>'posture') in ('contested', 'single_sided', 'empirical')
      and fact_explainer ? 'for_summary'
      and (
        not (fact_explainer ? 'source_url')
        or (fact_explainer->>'source_url') = ''
        or (fact_explainer->>'source_url') like 'https://%'
      )
    )
  );

-- Rebuild the partial index with the drop_at NOT NULL predicate.
-- CREATE INDEX IF NOT EXISTS skips if a prior-shape index exists under
-- the same name, so drop-then-create guarantees the new WHERE clause.
drop index if exists public.news_topics_fact_explainer_pending_idx;
create index news_topics_fact_explainer_pending_idx
  on public.news_topics (drop_at desc)
  where fact_explainer is null
    and drop_at is not null;

commit;

-- ---------------------------------------------------------------------------
-- Down (reference, not auto-run):
--   alter table public.news_topics
--     drop constraint if exists news_topics_fact_explainer_shape;
--   drop index if exists public.news_topics_fact_explainer_pending_idx;
--   create index news_topics_fact_explainer_pending_idx
--     on public.news_topics (drop_at desc)
--     where fact_explainer is null;
