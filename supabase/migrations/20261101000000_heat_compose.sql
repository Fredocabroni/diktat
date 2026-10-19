-- Migration: Heat composer columns + pg_cron entry
--
-- Plan v3 PR H (recreate off main; supersedes
-- supabase/migrations/20261028000000_heat_compose.sql on the closed
-- PR #255 — the old branch went `dirty` against main after
-- 20261024/20261025/20261030 landed and the 28 timestamp sank
-- below prod max). Adds `heat_score` + `heat_components` to
-- `news_topics_candidates` so the composer in
-- apps/workers/src/jobs/heat/compose.ts can write per-candidate
-- heat scores. HEAT_ENABLED=false by default; the walker's
-- Drop-selection logic does NOT read these columns yet (that flip
-- ships with a later plan v3 PR after P4 lands).
--
-- Columns:
--   heat_score numeric null     — scalar; higher = more audience heat.
--                                 null = composer hasn't scored this
--                                 candidate yet (or signals weren't
--                                 available). CHECK (null or >= 0).
--   heat_components jsonb null  — reproducibility snapshot: per-term
--                                 contributions, decay, weights,
--                                 computed_at. Enables post-hoc
--                                 refit and the nightly digest.
--
-- Both nullable, no default — pre-existing rows stay null until a
-- composer tick picks them up. No breaking change on readers.
--
-- Timestamp rationale (operator decision 2026-10-19): bumped from
-- the originally-queued 20261028 to 20261101. Prod max applied is
-- now 20261030000000 (X Trends cron, PR #261); 20261028 is BELOW
-- prod max and would be rejected by Supabase CLI's db push without
-- --include-all. 20261101 opens a clean slot above every merged
-- migration and leaves 20261102 / 20261103 for Wikimedia and
-- shadow-digest recreates (both of which depend on this file's
-- heat_score column).
--
-- Prod max applied: 20261030000000. This migration (20261101)
-- sorts strictly after. The composer reads trend_signals + the
-- gdelt_event_cluster shape, both from migrations already on main.
--
-- Up:
--   alter table public.news_topics_candidates
--     add column heat_score numeric,
--     add column heat_components jsonb;
--   add CHECK (heat_score is null or heat_score >= 0).
--   partial index for the composer's unscored-candidate scan.
--   pg_cron: heat_compose every 15 min.
--
-- Down (strict reversal order — cron first, then index, then columns):
--   select cron.unschedule('heat_compose');
--   drop index public.news_topics_candidates_unscored_idx;
--   alter table public.news_topics_candidates
--     drop constraint news_topics_candidates_heat_score_nonneg,
--     drop column heat_components,
--     drop column heat_score;

begin;

alter table public.news_topics_candidates
  add column heat_score numeric,
  add column heat_components jsonb;

-- Range guard on heat_score: all composer formulas produce non-
-- negative values (log1p of non-negatives, non-negative weights,
-- 0 ≤ decay ≤ 1, cross_bonus added not subtracted). A null row
-- stays "unscored"; a scored row must be ≥ 0. Catches a weight-
-- arithmetic bug before HEAT_ENABLED flips and the column becomes
-- load-bearing. CI security-reviewer LOW on the original #255.
alter table public.news_topics_candidates
  add constraint news_topics_candidates_heat_score_nonneg
    check (heat_score is null or heat_score >= 0);

comment on column public.news_topics_candidates.heat_score is
  'Shadow-mode heat score computed by the heat composer worker. Higher = more under-50 / Gen Z audience heat. Not read by Drop-selection logic until HEAT_ENABLED flips in a later PR.';
comment on column public.news_topics_candidates.heat_components is
  'Per-term contribution snapshot: {gdelt_term, google_term, x_term, bsky_term, cross_bonus, decay, weights:{w_g,w_gt,w_x,w_bsk,w_cross,half_life_hours}, computed_at}. Reproducibility for post-hoc refit + the nightly operator digest.';

-- Composer hot scan: active, unscored candidates in the window.
create index news_topics_candidates_unscored_idx
  on public.news_topics_candidates (created_at desc)
  where heat_score is null;

select cron.schedule(
  'heat_compose',
  '*/15 * * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key, payload)
    values (
      'heat_compose',
      to_char(now(), 'YYYY-MM-DD HH24:MI'),
      jsonb_build_object('emitted_at', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
    )
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

commit;
