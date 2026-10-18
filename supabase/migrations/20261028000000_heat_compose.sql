-- Migration: Heat composer columns + pg_cron entry
--
-- Plan v3 PR H. Adds `heat_score` + `heat_components` to
-- `news_topics_candidates` so the composer in
-- apps/workers/src/jobs/heat/compose.ts can write per-candidate
-- heat scores. HEAT_ENABLED=false by default; the walker's
-- Drop-selection logic does NOT read these columns yet (that
-- flip ships with a later plan v3 PR after P4 lands).
--
-- Columns:
--   heat_score numeric null     — scalar; higher = more audience heat.
--                                 null = composer hasn't scored this
--                                 candidate yet (or signals weren't
--                                 available).
--   heat_components jsonb null  — reproducibility snapshot: per-term
--                                 contributions, decay, weights,
--                                 computed_at. Enables post-hoc
--                                 refit and the nightly digest.
--
-- Both nullable, no default — pre-existing rows stay null until a
-- composer tick picks them up. No breaking change on readers.
--
-- Prod max applied: 20261024000000 (matcher, PR #251). This
-- migration (20261028) sorts strictly after. 20261025 (Bluesky),
-- 20261026 (X), 20261027 (Wikimedia) are sibling PRs that may or
-- may not be merged ahead of this one; none is a hard dependency
-- of this file (the composer only needs trend_signals from
-- 20261023 + news_topics_candidates from pre-existing migrations).
--
-- Up:
--   alter table public.news_topics_candidates
--     add column heat_score numeric,
--     add column heat_components jsonb;
--   partial index for the composer's unscored-candidate scan.
--   pg_cron: heat_compose every 15 min.
--
-- Down (strict reversal order — cron first, then index, then columns):
--   select cron.unschedule('heat_compose');
--   drop index public.news_topics_candidates_unscored_idx;
--   alter table public.news_topics_candidates
--     drop column heat_components,
--     drop column heat_score;

begin;

alter table public.news_topics_candidates
  add column heat_score numeric,
  add column heat_components jsonb;

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
