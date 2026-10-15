-- Behavioral test: PR C — pick_drop_eligible_candidates enforces S3.
--
-- Covers five scenarios (operator spec):
--   (A) primary-tier candidate → passes without any cluster shape
--   (B) reputable-tier candidate whose cluster has >=2 hosts from
--       >=2 outlet_groups and >=1 news-type outlet → passes
--   (C) reputable candidate whose cluster has only 1 outlet_group
--       → fails
--   (D) reputable candidate whose cluster has 2 outlet_groups but
--       zero news-type outlets (only commentary) → fails
--   (E) reputable candidate whose cluster is Drop-published already
--       (gdelt_event_cluster.drop_published_at not null) → fails
--
-- Also verifies the commentary-as-candidate toggle:
--   (F) commentary-outlet candidate with default
--       p_commentary_as_drop_candidate=false → excluded
--   (G) same candidate with p_commentary_as_drop_candidate=true →
--       included
--
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file

begin;

-- ---------------------------------------------------------------------------
-- Fixtures. Five distinct clusters, each with its outlet rows set to shape
-- the S3 pass/fail case. Candidates created last so their global_event_id
-- can key the matching cluster.
-- ---------------------------------------------------------------------------

-- Cluster A: no cluster row (candidate is primary — RPC does not require
-- a cluster for primary/direct).
insert into public.news_topics_candidates (
  source_provider, source_category, source_title, source_url, source_host,
  dedup_url_canon, dedup_cluster_id, rank_score, evidence_tier, global_event_id
) values (
  'sec_rss', 'sec_filings',
  'A primary candidate', 'https://www.sec.gov/pr/a',
  'sec.gov', 'sec.gov/pr/a',
  'aaaa0000-0000-4000-8000-000000000001',
  0.9, 'primary', null
);

-- Cluster B: 2 hosts, 2 outlet_groups, 1 news-type → S3 pass.
insert into public.gdelt_event_cluster (global_event_id, primary_url, primary_host, primary_tier)
  values ('cluster-B-passes', null, null, null);
insert into public.gdelt_event_cluster_outlet
  (global_event_id, host, outlet_lean, outlet_group, outlet_type, url) values
  ('cluster-B-passes', 'apnews.com',  'center', 'center', 'news', 'https://apnews.com/b-1'),
  ('cluster-B-passes', 'wsj.com',     'right',  'right',  'news', 'https://wsj.com/b-2');
insert into public.news_topics_candidates (
  source_provider, source_category, source_title, source_url, source_host,
  dedup_url_canon, dedup_cluster_id, rank_score, evidence_tier,
  outlet_lean, outlet_group, outlet_type, global_event_id
) values (
  'gdelt', 'news',
  'A reputable B candidate', 'https://apnews.com/b-1',
  'apnews.com', 'apnews.com/b-1',
  'bbbb0000-0000-4000-8000-000000000001',
  0.8, 'reputable', 'center', 'center', 'news', 'cluster-B-passes'
);

-- Cluster C: only 1 outlet_group (both outlets are 'center').
insert into public.gdelt_event_cluster (global_event_id)
  values ('cluster-C-one-group');
insert into public.gdelt_event_cluster_outlet
  (global_event_id, host, outlet_lean, outlet_group, outlet_type, url) values
  ('cluster-C-one-group', 'apnews.com', 'center', 'center', 'news', 'https://apnews.com/c-1'),
  ('cluster-C-one-group', 'reuters.com','center', 'center', 'news', 'https://reuters.com/c-2');
insert into public.news_topics_candidates (
  source_provider, source_category, source_title, source_url, source_host,
  dedup_url_canon, dedup_cluster_id, rank_score, evidence_tier,
  outlet_lean, outlet_group, outlet_type, global_event_id
) values (
  'gdelt', 'news',
  'A reputable C candidate (one-group)', 'https://apnews.com/c-1',
  'apnews.com', 'apnews.com/c-1',
  'cccc0000-0000-4000-8000-000000000001',
  0.7, 'reputable', 'center', 'center', 'news', 'cluster-C-one-group'
);

-- Cluster D: 2 outlet_groups but ZERO news-type outlets (both commentary).
insert into public.gdelt_event_cluster (global_event_id)
  values ('cluster-D-no-news');
insert into public.gdelt_event_cluster_outlet
  (global_event_id, host, outlet_lean, outlet_group, outlet_type, url) values
  ('cluster-D-no-news', 'motherjones.com',   'left',  'left',  'commentary', 'https://motherjones.com/d-1'),
  ('cluster-D-no-news', 'nationalreview.com','right', 'right', 'commentary', 'https://nationalreview.com/d-2');
-- Pair with a news-type reputable candidate that is NOT in the cluster's
-- outlet set — the operator spec intentionally couples eligibility to the
-- cluster's shape, not the candidate's own outlet type.
insert into public.news_topics_candidates (
  source_provider, source_category, source_title, source_url, source_host,
  dedup_url_canon, dedup_cluster_id, rank_score, evidence_tier,
  outlet_lean, outlet_group, outlet_type, global_event_id
) values (
  'gdelt', 'news',
  'A reputable D candidate (no news-type in cluster)', 'https://apnews.com/d-1',
  'apnews.com', 'apnews.com/d-1',
  'dddd0000-0000-4000-8000-000000000001',
  0.6, 'reputable', 'center', 'center', 'news', 'cluster-D-no-news'
);

-- Cluster E: valid S3 shape BUT drop_published_at already stamped.
insert into public.gdelt_event_cluster (global_event_id, drop_published_at)
  values ('cluster-E-already-published', '2026-10-01 00:00:00+00');
insert into public.gdelt_event_cluster_outlet
  (global_event_id, host, outlet_lean, outlet_group, outlet_type, url) values
  ('cluster-E-already-published', 'apnews.com', 'center', 'center', 'news', 'https://apnews.com/e-1'),
  ('cluster-E-already-published', 'wsj.com',    'right',  'right',  'news', 'https://wsj.com/e-2');
insert into public.news_topics_candidates (
  source_provider, source_category, source_title, source_url, source_host,
  dedup_url_canon, dedup_cluster_id, rank_score, evidence_tier,
  outlet_lean, outlet_group, outlet_type, global_event_id
) values (
  'gdelt', 'news',
  'A reputable E candidate (cluster already published)', 'https://apnews.com/e-1',
  'apnews.com', 'apnews.com/e-1',
  'eeee0000-0000-4000-8000-000000000001',
  0.5, 'reputable', 'center', 'center', 'news', 'cluster-E-already-published'
);

-- Cluster F: valid S3 shape BUT the candidate's own outlet_type is
-- commentary. Default p_commentary_as_drop_candidate=false → excluded.
insert into public.gdelt_event_cluster (global_event_id)
  values ('cluster-F-commentary-candidate');
insert into public.gdelt_event_cluster_outlet
  (global_event_id, host, outlet_lean, outlet_group, outlet_type, url) values
  ('cluster-F-commentary-candidate', 'apnews.com',   'center', 'center', 'news',      'https://apnews.com/f-1'),
  ('cluster-F-commentary-candidate', 'motherjones.com','left', 'left',   'commentary','https://motherjones.com/f-2');
insert into public.news_topics_candidates (
  source_provider, source_category, source_title, source_url, source_host,
  dedup_url_canon, dedup_cluster_id, rank_score, evidence_tier,
  outlet_lean, outlet_group, outlet_type, global_event_id
) values (
  'gdelt', 'news',
  'A commentary-outlet candidate', 'https://motherjones.com/f-2',
  'motherjones.com', 'motherjones.com/f-2',
  'ffff0000-0000-4000-8000-000000000001',
  0.4, 'reputable', 'left', 'left', 'commentary', 'cluster-F-commentary-candidate'
);

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------

-- (A) + (B) pass; (C), (D), (E), (F) excluded under the default flip.
do $$
declare
  v_got text;
begin
  select string_agg(id::text, ',' order by rank_score desc)
    into v_got
    from public.pick_drop_eligible_candidates()
    where id in (
      'aaaa0000-0000-4000-8000-000000000001',
      'bbbb0000-0000-4000-8000-000000000001',
      'cccc0000-0000-4000-8000-000000000001',
      'dddd0000-0000-4000-8000-000000000001',
      'eeee0000-0000-4000-8000-000000000001',
      'ffff0000-0000-4000-8000-000000000001'
    );
  if v_got is distinct from 'aaaa0000-0000-4000-8000-000000000001,bbbb0000-0000-4000-8000-000000000001' then
    raise exception 'default flip: expected A+B only, got %', coalesce(v_got, '<null>');
  end if;
end$$;

-- (G) with p_commentary_as_drop_candidate=true: F is included.
do $$
declare
  v_got text;
begin
  select string_agg(id::text, ',' order by rank_score desc)
    into v_got
    from public.pick_drop_eligible_candidates(p_commentary_as_drop_candidate => true)
    where id in (
      'aaaa0000-0000-4000-8000-000000000001',
      'bbbb0000-0000-4000-8000-000000000001',
      'cccc0000-0000-4000-8000-000000000001',
      'dddd0000-0000-4000-8000-000000000001',
      'eeee0000-0000-4000-8000-000000000001',
      'ffff0000-0000-4000-8000-000000000001'
    );
  if v_got is distinct from 'aaaa0000-0000-4000-8000-000000000001,bbbb0000-0000-4000-8000-000000000001,ffff0000-0000-4000-8000-000000000001' then
    raise exception 'commentary-on flip: expected A+B+F, got %', coalesce(v_got, '<null>');
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- stamp_cluster_drop_published: returns true the first time, false after.
-- ---------------------------------------------------------------------------

insert into public.gdelt_event_cluster (global_event_id)
  values ('cluster-stamp-test');

do $$
declare
  v_first boolean;
  v_second boolean;
begin
  v_first := public.stamp_cluster_drop_published('cluster-stamp-test');
  if v_first is distinct from true then
    raise exception 'first stamp should return true, got %', v_first;
  end if;
  v_second := public.stamp_cluster_drop_published('cluster-stamp-test');
  if v_second is distinct from false then
    raise exception 'second stamp should return false (idempotent), got %', v_second;
  end if;
end$$;

-- stamp on an unknown cluster: returns false.
do $$
declare
  v_result boolean;
begin
  v_result := public.stamp_cluster_drop_published('cluster-does-not-exist');
  if v_result is distinct from false then
    raise exception 'stamp on unknown cluster should return false, got %', v_result;
  end if;
end$$;

rollback;
