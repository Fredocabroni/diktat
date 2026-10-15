-- Behavioral test: PR #220 push-2 security-reviewer LOW 1 — the
-- gdelt_event_cluster/outlet https CHECK constraints must reject a
-- URL that passes requireHttpsUrl() but has no host segment
-- (bare scheme `https://`, or `https:// internal.svc/` with embedded
-- whitespace). Covers all three columns constrained in migration
-- 20261018000000: gdelt_event_cluster.primary_url (nullable, NULL
-- branch preserved), gdelt_event_cluster.best_news_url (nullable,
-- no NULL branch — Postgres CHECK semantics skip NULL rows), and
-- gdelt_event_cluster_outlet.url (NOT NULL).
--
-- Catches: a future loosening of the DB-side pattern back to the
-- old `LIKE 'https://%'` form (or any pattern that accepts the
-- bare-scheme / whitespace-after-scheme bypasses the TS layer
-- cannot see).
--
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file

begin;

-- ---------------------------------------------------------------------------
-- Fixture: one minimal cluster row with primary_url NULL (the only legal
-- zero-primary state per the gdelt_event_cluster_primary_tier_coherent
-- CHECK from migration 20261016000000).
-- ---------------------------------------------------------------------------
insert into public.gdelt_event_cluster (global_event_id)
values ('gdelt-https-check-test-1');

-- ---------------------------------------------------------------------------
-- 1. primary_url: bare-scheme and whitespace-after-scheme must FAIL.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update public.gdelt_event_cluster
      set primary_url = 'https://',
          primary_host = 'placeholder.local',
          primary_tier = 'primary'
      where global_event_id = 'gdelt-https-check-test-1';
    raise exception 'expected primary_url = ''https://'' to be rejected by gdelt_event_cluster_primary_url_https';
  exception when check_violation then
    null;
  end;
end$$;

do $$
begin
  begin
    update public.gdelt_event_cluster
      set primary_url = 'https:// example.com/',
          primary_host = 'example.com',
          primary_tier = 'primary'
      where global_event_id = 'gdelt-https-check-test-1';
    raise exception 'expected primary_url = ''https:// example.com/'' to be rejected by gdelt_event_cluster_primary_url_https';
  exception when check_violation then
    null;
  end;
end$$;

-- A well-formed primary URL passes.
update public.gdelt_event_cluster
  set primary_url = 'https://supremecourt.gov/opinions/22pdf/22-123_abc.pdf',
      primary_host = 'supremecourt.gov',
      primary_tier = 'primary'
  where global_event_id = 'gdelt-https-check-test-1';

-- ---------------------------------------------------------------------------
-- 2. best_news_url: bare-scheme must FAIL. NULL stays legal (the
--    constraint has no NULL branch — Postgres CHECK semantics let
--    NULL rows through).
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update public.gdelt_event_cluster
      set best_news_url = 'https://',
          best_news_host = 'placeholder.local'
      where global_event_id = 'gdelt-https-check-test-1';
    raise exception 'expected best_news_url = ''https://'' to be rejected by gdelt_event_cluster_best_news_url_https';
  exception when check_violation then
    null;
  end;
end$$;

-- best_news_url null + best_news_host null remains legal (satisfies
-- gdelt_event_cluster_best_news_coherent and the new https CHECK).
update public.gdelt_event_cluster
  set best_news_url = null,
      best_news_host = null
  where global_event_id = 'gdelt-https-check-test-1';

-- A well-formed best_news_url passes.
update public.gdelt_event_cluster
  set best_news_url = 'https://apnews.com/article/abc-123',
      best_news_host = 'apnews.com'
  where global_event_id = 'gdelt-https-check-test-1';

-- ---------------------------------------------------------------------------
-- 3. outlet.url: bare-scheme must FAIL.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into public.gdelt_event_cluster_outlet
      (global_event_id, host, url)
      values ('gdelt-https-check-test-1', 'placeholder.local', 'https://');
    raise exception 'expected outlet.url = ''https://'' to be rejected by gdelt_event_cluster_outlet_url_https';
  exception when check_violation then
    null;
  end;
end$$;

-- A well-formed outlet row passes.
insert into public.gdelt_event_cluster_outlet
  (global_event_id, host, url)
  values ('gdelt-https-check-test-1', 'apnews.com', 'https://apnews.com/article/abc-123');

rollback;
