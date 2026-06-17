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
--
-- RLS posture (PR #40 round-2 security-reviewer MEDIUM #2 — verified):
--   * The pre-existing `news_topics_select_all` policy
--     (migration 20260420090005:26) declares `for select to anon,
--     authenticated using (true)`. PR #40 confirmed this is a
--     DECLARED policy, not the effective one. No GRANT exists for
--     anon or authenticated on any table in `public` (verified with
--     a forged `role: authenticated` JWT against `/rest/v1/news_topics`
--     → `42501 permission denied`). Direct PostgREST reads with the
--     anon key or any authenticated bearer are denied at the
--     table-privilege layer before RLS is consulted, so the
--     "read-all" wording in the policy does not surface data
--     to clients.
--   * The intended access path is `trpc.feed.list` only. That router
--     filters to `is_drop=true AND drop_at <= now()` (server-side
--     `Math.min` clamp + input-schema `.refine` reject future
--     cursors), so even if the table-level GRANT is later added to
--     close the systemic posture gap, no future-dated or unreleased
--     row leaks through this read surface.
--   * The systemic discovery — that ZERO public tables are reachable
--     by client roles via PostgREST in the dev DB — is logged for
--     pre-launch attention in `docs/TYRION_BUILD_QUEUE.md` as a
--     separate cross-cutting follow-up. Not introduced by this PR;
--     surfaces because the security-reviewer flagged the news_topics
--     policy specifically.

begin;

alter table public.news_topics
  add column if not exists is_block_exhausted boolean not null default false;

commit;
