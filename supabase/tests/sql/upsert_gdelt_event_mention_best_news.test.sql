-- Behavioral test: #215 LOW 3 — the `upsert_gdelt_event_mention`
-- SQL function's best_news_url column path. Verifies that calling
-- the RPC with (p_is_paywall_free_preferred=true, p_outlet_type='news')
-- populates `gdelt_event_cluster.best_news_url` + `best_news_host`,
-- and that commentary-outlet mentions NEVER populate best_news_url
-- regardless of the paywall-free flag.
--
-- Coverage this closes:
--   (A) first paywall-free news mention: best_news_url gets stamped.
--   (B) second paywall-free news mention on same cluster: first-seen-
--       wins (coalesce), best_news_url unchanged.
--   (C) commentary mention with paywall-free=true: best_news_url
--       stays null (commentary never carries evidence per operator
--       spec; the function already enforces this via
--       `v_is_paywall_free_news := … AND p_outlet_type = 'news'`).
--   (D) news mention with paywall-free=false (preference-order outlet
--       is NOT first in): best_news_url stays null.
--
-- The TS-side coverage (apps/workers/__tests__/jobs/news-ingest.test.ts
-- L1303) already asserts the RPC call args shape. This SQL test
-- closes the loop at the storage layer: given the right args, the
-- column gets written as the operator spec expects.
--
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file

begin;

-- ---------------------------------------------------------------------------
-- (A) First paywall-free news mention: best_news_url + best_news_host set.
-- ---------------------------------------------------------------------------

select public.upsert_gdelt_event_mention(
  p_global_event_id => 'test-case-a',
  p_url => 'https://apnews.com/article/aaa',
  p_host => 'apnews.com',
  p_evidence_tier => 'reputable',
  p_outlet_lean => 'center',
  p_outlet_group => 'center',
  p_outlet_type => 'news',
  p_is_paywall_free_preferred => true
);

do $$
declare
  v_best_url text;
  v_best_host text;
begin
  select best_news_url, best_news_host
    into v_best_url, v_best_host
    from public.gdelt_event_cluster
    where global_event_id = 'test-case-a';
  if v_best_url is distinct from 'https://apnews.com/article/aaa' then
    raise exception '(A) expected best_news_url to be stamped, got %', coalesce(v_best_url, '<null>');
  end if;
  if v_best_host is distinct from 'apnews.com' then
    raise exception '(A) expected best_news_host=apnews.com, got %', coalesce(v_best_host, '<null>');
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- (B) Second paywall-free news mention on same cluster: first-seen-wins.
--     The function COALESCEs best_news_url so the second write must
--     not clobber the first.
-- ---------------------------------------------------------------------------

select public.upsert_gdelt_event_mention(
  p_global_event_id => 'test-case-a',
  p_url => 'https://reuters.com/article/second',
  p_host => 'reuters.com',
  p_evidence_tier => 'reputable',
  p_outlet_lean => 'center',
  p_outlet_group => 'center',
  p_outlet_type => 'news',
  p_is_paywall_free_preferred => true
);

do $$
declare
  v_best_url text;
begin
  select best_news_url into v_best_url
    from public.gdelt_event_cluster
    where global_event_id = 'test-case-a';
  if v_best_url is distinct from 'https://apnews.com/article/aaa' then
    raise exception '(B) expected first-seen best_news_url retained, got %', coalesce(v_best_url, '<null>');
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- (C) Commentary mention with paywall-free=true: best_news_url stays null.
--     The function logic is `v_is_paywall_free_news := paywall_free
--     AND p_outlet_type = 'news'`, so commentary short-circuits.
-- ---------------------------------------------------------------------------

select public.upsert_gdelt_event_mention(
  p_global_event_id => 'test-case-c',
  p_url => 'https://motherjones.com/article/opinion',
  p_host => 'motherjones.com',
  p_evidence_tier => 'reputable',
  p_outlet_lean => 'left',
  p_outlet_group => 'left',
  p_outlet_type => 'commentary',
  p_is_paywall_free_preferred => true
);

do $$
declare
  v_best_url text;
  v_best_host text;
begin
  select best_news_url, best_news_host
    into v_best_url, v_best_host
    from public.gdelt_event_cluster
    where global_event_id = 'test-case-c';
  if v_best_url is not null then
    raise exception '(C) expected commentary mention to leave best_news_url null, got %', v_best_url;
  end if;
  if v_best_host is not null then
    raise exception '(C) expected best_news_host null for commentary mention, got %', v_best_host;
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- (D) News mention with paywall-free=false: best_news_url stays null.
--     The caller (news-ingest.ts) only sets paywall-free=true on hosts
--     in PAYWALL_FREE_PREFERRED_HOSTS. A non-preferred news mention
--     (e.g. nytimes.com) arrives with the flag=false, and the SQL
--     function MUST NOT stamp best_news_url for it.
-- ---------------------------------------------------------------------------

select public.upsert_gdelt_event_mention(
  p_global_event_id => 'test-case-d',
  p_url => 'https://nytimes.com/article/paywalled',
  p_host => 'nytimes.com',
  p_evidence_tier => 'reputable',
  p_outlet_lean => 'lean-left',
  p_outlet_group => 'left',
  p_outlet_type => 'news',
  p_is_paywall_free_preferred => false
);

do $$
declare
  v_best_url text;
begin
  select best_news_url into v_best_url
    from public.gdelt_event_cluster
    where global_event_id = 'test-case-d';
  if v_best_url is not null then
    raise exception '(D) expected non-preferred news mention to leave best_news_url null, got %', v_best_url;
  end if;
end$$;

rollback;
