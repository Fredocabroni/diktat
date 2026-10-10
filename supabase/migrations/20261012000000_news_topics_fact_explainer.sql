-- Migration: add fact_explainer jsonb column + timestamp to news_topics.
-- Up:   Two columns on public.news_topics:
--         - fact_explainer jsonb (nullable) — the generated explainer
--           payload. Shape: { for_summary, against_summary, source_url,
--           posture }. See packages/ai-fabric/src/prompts/fact-explainer.ts
--           for the schema contract.
--         - fact_explainer_generated_at timestamptz (nullable) — stamped
--           when the ai-fabric task returned successfully. NULL means
--           either the row predates A4 OR generation failed and the
--           pipeline fell through to the raw primary-source link.
-- Down: drop both columns. No data is destroyed because the explainer is
--       always regeneratable from source_title + primary_source_url via
--       the same ai-fabric task.
--
-- Design context (A4 from docs/phase-5/launch-shape-2026-10-10.md):
--   * Operator decision 4 (2026-10-10): the explainer is generated at
--     drop-publish AND at "other-topics" promotion (step 5 of the launch
--     build order). Both pipelines call the same task and write both
--     columns atomically. This migration only adds the storage shape;
--     the drop-publish wiring lands in the same PR; the other-topics
--     wiring lands in its own PR (step 5).
--   * The null-on-failure pattern mirrors drop-publish.ts's existing
--     rewrite.headline-length check: if the ai-fabric task returns
--     empty strings OR throws, we persist null and the UI falls through
--     to the raw primary_source_url link.
--   * No RLS change: news_topics is read-public ("news_topics_select_all"
--     migration 20260420090005:26). The explainer is public content; it
--     has the same visibility as the headline.
--
-- SQL tests: covered via the drop-publish handler integration tests in
--   apps/workers/__tests__/jobs/drop-publish.test.ts (new cases: happy
--   path writes JSON; failure writes null; null-on-empty-output).

begin;

alter table public.news_topics
  add column if not exists fact_explainer jsonb,
  add column if not exists fact_explainer_generated_at timestamptz;

-- Defense-in-depth CHECK constraint. Application-layer validation lives
-- in two places (Zod schema in drop-publish.ts at write; parseFactExplainer
-- in feed.ts at read), but a direct psql session, migration script, or
-- future misconfigured worker could persist an arbitrary payload — in
-- particular a non-https source_url, which DropCard renders inside an
-- anchor. The CHECK rejects any payload shape outside the contract.
-- Security-reviewer PR #198 MEDIUM #1.
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

-- Partial index on NULL-explainer rows so a future backfill job can
-- find candidates cheaply. Narrowed to drop_at IS NOT NULL so retracted
-- or pre-publication rows aren't picked up by a hypothetical backfill
-- iterator — a retracted topic should never gain a freshly generated
-- explainer that then flows to clients (security-reviewer PR #198
-- LOW index-predicate fold-in).
create index if not exists news_topics_fact_explainer_pending_idx
  on public.news_topics (drop_at desc)
  where fact_explainer is null
    and drop_at is not null;

commit;

-- ---------------------------------------------------------------------------
-- Down (reference, not auto-run):
--   drop index if exists public.news_topics_fact_explainer_pending_idx;
--   alter table public.news_topics
--     drop column if exists fact_explainer_generated_at,
--     drop column if exists fact_explainer;
