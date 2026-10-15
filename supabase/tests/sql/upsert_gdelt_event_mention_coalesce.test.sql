-- Behavioral test: #215 INFO — coalesce clarity on
-- upsert_gdelt_event_mention.
--
-- Proves the identity we're asserting with the coalesce: an explicit
-- NULL p_is_paywall_free_preferred (treated the same as FALSE by
-- coalesce) must behave the same as the default-FALSE caller.
-- Specifically, best_news_url must stay NULL on a mention where the
-- flag is NULL, matching the behavior of a mention where the flag is
-- explicitly FALSE.
--
-- Before the coalesce migration: paywall_free=NULL AND
-- outlet_type='news' → NULL AND true → NULL → CASE WHEN NULL treats
-- as falsy → best_news_url stays null. Behavior same. So the test is
-- a non-regression guard, not a behavior change check.
--
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file

begin;

-- Case 1: paywall_free=NULL + outlet_type='news' → best_news_url NULL
select public.upsert_gdelt_event_mention(
  p_global_event_id => 'coalesce-null-case',
  p_url => 'https://apnews.com/a',
  p_host => 'apnews.com',
  p_evidence_tier => 'reputable',
  p_outlet_lean => 'center',
  p_outlet_group => 'center',
  p_outlet_type => 'news',
  p_is_paywall_free_preferred => null
);

do $$
declare v_url text;
begin
  select best_news_url into v_url
    from public.gdelt_event_cluster
    where global_event_id = 'coalesce-null-case';
  if v_url is not null then
    raise exception 'paywall_free=NULL + news should leave best_news_url null, got %', v_url;
  end if;
end$$;

-- Case 2: paywall_free=FALSE + outlet_type='news' → best_news_url NULL
--   (same as case 1 — proves equivalence).
select public.upsert_gdelt_event_mention(
  p_global_event_id => 'coalesce-false-case',
  p_url => 'https://apnews.com/b',
  p_host => 'apnews.com',
  p_evidence_tier => 'reputable',
  p_outlet_lean => 'center',
  p_outlet_group => 'center',
  p_outlet_type => 'news',
  p_is_paywall_free_preferred => false
);

do $$
declare v_url text;
begin
  select best_news_url into v_url
    from public.gdelt_event_cluster
    where global_event_id = 'coalesce-false-case';
  if v_url is not null then
    raise exception 'paywall_free=FALSE + news should leave best_news_url null, got %', v_url;
  end if;
end$$;

-- Case 3: paywall_free=TRUE + outlet_type='news' → best_news_url set
--   (confirms the positive branch still writes).
select public.upsert_gdelt_event_mention(
  p_global_event_id => 'coalesce-true-case',
  p_url => 'https://apnews.com/c',
  p_host => 'apnews.com',
  p_evidence_tier => 'reputable',
  p_outlet_lean => 'center',
  p_outlet_group => 'center',
  p_outlet_type => 'news',
  p_is_paywall_free_preferred => true
);

do $$
declare v_url text;
begin
  select best_news_url into v_url
    from public.gdelt_event_cluster
    where global_event_id = 'coalesce-true-case';
  if v_url is distinct from 'https://apnews.com/c' then
    raise exception 'paywall_free=TRUE + news should set best_news_url, got %', coalesce(v_url, '<null>');
  end if;
end$$;

-- Case 4: paywall_free=NULL + outlet_type=NULL (primary tier) →
-- best_news_url NULL.
select public.upsert_gdelt_event_mention(
  p_global_event_id => 'coalesce-primary-null-case',
  p_url => 'https://www.sec.gov/x',
  p_host => 'sec.gov',
  p_evidence_tier => 'primary',
  p_outlet_lean => null,
  p_outlet_group => null,
  p_outlet_type => null,
  p_is_paywall_free_preferred => null
);

do $$
declare v_url text;
begin
  select best_news_url into v_url
    from public.gdelt_event_cluster
    where global_event_id = 'coalesce-primary-null-case';
  if v_url is not null then
    raise exception 'primary tier with paywall_free=NULL should leave best_news_url null, got %', v_url;
  end if;
end$$;

rollback;
