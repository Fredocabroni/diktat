-- Migration: A6 (debate_question) column on public.news_topics.
-- Up:   add a nullable `debate_question text` column + CHECK ensuring
--       the value is either NULL (A6 off / no fair question) or a
--       trimmed string whose char_length is in [10, 200] AND ends with
--       '?'. Pairs with the application-side Zod refine in
--       apps/workers/src/jobs/drop-publish.ts: DropHeadlineRewriteSchema.
-- Down: drop column public.news_topics.debate_question;
--
-- Design context (A6 — architect proposal, operator-approved 2026-10-10):
--   The live cards sometimes rewrote procedural headlines into
--   declarative facts and surfaced them directly above the two stance
--   buttons. Voters tapping a button were agreeing to a fact, not
--   expressing a stance. A6 fixes this by generating a yes/no debate
--   question in the same ai-fabric call that produces the headline;
--   the DropCard renders the question ABOVE the stance buttons and
--   the headline becomes the context line above the question. If the
--   model cannot produce a fair question, drop-publish SKIPS the
--   Drop (never persists a row).
--
-- The column is nullable because:
--   - A6_ENABLED is false at migration-apply time; existing cards
--     continue to render without a question until the flag flips.
--   - Future "other-topics" promotion (step 5 of the launch build order)
--     may surface topics that don't call this task, in which case the
--     column stays NULL for those rows.
--
-- The CHECK constraint uses the same shape as the application-side
-- Zod refine (ends-with-?, 10..200 chars) so a direct psql write
-- cannot land a malformed question that the write path would reject.
-- Three-layer defense: Zod on the write path, CHECK here, and read-
-- time null fallback on the API side.

begin;

alter table public.news_topics
  add column debate_question text;

alter table public.news_topics
  add constraint news_topics_debate_question_shape check (
    debate_question is null or (
      char_length(debate_question) between 10 and 200
      and debate_question like '%?'
      and position('<' in debate_question) = 0
      and position('>' in debate_question) = 0
    )
  ) not valid;

alter table public.news_topics
  validate constraint news_topics_debate_question_shape;

-- Lock profile note (same pattern as 20261012010000 — see that
-- migration's header for the full discussion). news_topics is <1k
-- rows at launch so the one-transaction NOT VALID + VALIDATE pattern
-- here holds ACCESS EXCLUSIVE for a sub-second window; acceptable at
-- this scale. For a growing table, split into two migration files.

commit;

-- ---------------------------------------------------------------------------
-- Down (reference, not auto-run):
--   alter table public.news_topics
--     drop constraint if exists news_topics_debate_question_shape;
--   alter table public.news_topics
--     drop column if exists debate_question;
