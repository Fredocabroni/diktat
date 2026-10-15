-- Behavioral test: PR #221 push-2 security-reviewer MEDIUM — the
-- gdelt_event_cluster/outlet https CHECK constraints must reject URLs
-- that pass requireHttpsUrl() at the TS layer but represent a storage-
-- layer bypass (credential-injection via `@`, bare scheme, whitespace
-- anywhere in the URL, trailing CR). Covers all three columns
-- constrained in migration 20261018000000:
--   * gdelt_event_cluster.primary_url (nullable, NULL branch kept)
--   * gdelt_event_cluster.best_news_url (nullable, no NULL branch —
--       Postgres CHECK semantics skip NULL rows)
--   * gdelt_event_cluster_outlet.url (NOT NULL)
--
-- Each negative case asserts the SPECIFIC constraint name via
-- `GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME`, so a
-- future loosening cannot slip through by tripping an unrelated
-- CHECK (e.g. primary_tier_coherent, best_news_coherent).
--
-- Positive cases cover the four non-obvious legal shapes called out
-- in the #221 security review (host[:port], host?query, host#frag,
-- host/@user), plus the baseline well-formed URLs.
--
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file

begin;

-- ---------------------------------------------------------------------------
-- Fixture: one minimal cluster row with primary_url NULL (only legal
-- zero-primary state per gdelt_event_cluster_primary_tier_coherent).
-- The negative-case UPDATEs below pair primary_url (illegal value)
-- with primary_host + primary_tier set to legal values so that
-- primary_tier_coherent is satisfied — the only CHECK that CAN fire
-- is gdelt_event_cluster_primary_url_https.
-- ---------------------------------------------------------------------------
insert into public.gdelt_event_cluster (global_event_id)
values ('gdelt-https-check-test-1');

-- ---------------------------------------------------------------------------
-- Harness: run a WRITE expected to fail with check_violation, and
-- assert the SPECIFIC constraint caught it.
-- ---------------------------------------------------------------------------
--
-- `expect_check_violation(write_sql text, expected_constraint text, label text)`
-- builds and executes `write_sql` via EXECUTE, then:
--   * if the write succeeds, raises an assertion error naming `label`.
--   * if a check_violation is raised, inspects CONSTRAINT_NAME from
--     stacked diagnostics and raises an assertion error if it does
--     not match `expected_constraint`.
--   * any other error propagates.
create function pg_temp.expect_check_violation(
  write_sql text,
  expected_constraint text,
  label text
) returns void
language plpgsql as $$
declare
  v_constraint text;
begin
  begin
    execute write_sql;
    raise exception
      'expected check_violation on constraint % for %, but write succeeded',
      expected_constraint, label;
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from expected_constraint then
      raise exception
        'expected check_violation on constraint %, got % for %',
        expected_constraint, v_constraint, label;
    end if;
  end;
end$$;

-- ---------------------------------------------------------------------------
-- 1. primary_url — six adversarial inputs, each must trip
--    gdelt_event_cluster_primary_url_https.
-- ---------------------------------------------------------------------------
select pg_temp.expect_check_violation(
  $sql$ update public.gdelt_event_cluster
          set primary_url = 'https://',
              primary_host = 'placeholder.local',
              primary_tier = 'primary'
          where global_event_id = 'gdelt-https-check-test-1' $sql$,
  'gdelt_event_cluster_primary_url_https',
  'primary_url: bare scheme'
);

select pg_temp.expect_check_violation(
  $sql$ update public.gdelt_event_cluster
          set primary_url = 'https:// example.com/',
              primary_host = 'example.com',
              primary_tier = 'primary'
          where global_event_id = 'gdelt-https-check-test-1' $sql$,
  'gdelt_event_cluster_primary_url_https',
  'primary_url: whitespace after scheme'
);

select pg_temp.expect_check_violation(
  $sql$ update public.gdelt_event_cluster
          set primary_url = 'https://attacker.com@internal.svc/',
              primary_host = 'internal.svc',
              primary_tier = 'primary'
          where global_event_id = 'gdelt-https-check-test-1' $sql$,
  'gdelt_event_cluster_primary_url_https',
  'primary_url: user@host credential-injection'
);

select pg_temp.expect_check_violation(
  $sql$ update public.gdelt_event_cluster
          set primary_url = 'https://user:pass@example.com/',
              primary_host = 'example.com',
              primary_tier = 'primary'
          where global_event_id = 'gdelt-https-check-test-1' $sql$,
  'gdelt_event_cluster_primary_url_https',
  'primary_url: user:pass@host credential-injection'
);

select pg_temp.expect_check_violation(
  $sql$ update public.gdelt_event_cluster
          set primary_url = 'https://example.com/a b',
              primary_host = 'example.com',
              primary_tier = 'primary'
          where global_event_id = 'gdelt-https-check-test-1' $sql$,
  'gdelt_event_cluster_primary_url_https',
  'primary_url: whitespace in path'
);

select pg_temp.expect_check_violation(
  format(
    $sql$ update public.gdelt_event_cluster
            set primary_url = %L,
                primary_host = 'example.com',
                primary_tier = 'primary'
            where global_event_id = 'gdelt-https-check-test-1' $sql$,
    'https://example.com' || chr(13)
  ),
  'gdelt_event_cluster_primary_url_https',
  'primary_url: trailing CR'
);

-- A set of well-formed primary URLs must pass. Each UPDATE commits
-- (within this transaction) so the next write starts from a known-
-- good state.
update public.gdelt_event_cluster
  set primary_url = 'https://supremecourt.gov/opinions/22pdf/22-123_abc.pdf',
      primary_host = 'supremecourt.gov',
      primary_tier = 'primary'
  where global_event_id = 'gdelt-https-check-test-1';

update public.gdelt_event_cluster
  set primary_url = 'https://medium.com/@someuser',
      primary_host = 'medium.com',
      primary_tier = 'primary'
  where global_event_id = 'gdelt-https-check-test-1';

update public.gdelt_event_cluster
  set primary_url = 'https://example.com?q=1',
      primary_host = 'example.com',
      primary_tier = 'primary'
  where global_event_id = 'gdelt-https-check-test-1';

update public.gdelt_event_cluster
  set primary_url = 'https://example.com:8443/a',
      primary_host = 'example.com',
      primary_tier = 'primary'
  where global_event_id = 'gdelt-https-check-test-1';

update public.gdelt_event_cluster
  set primary_url = 'https://example.com#frag',
      primary_host = 'example.com',
      primary_tier = 'primary'
  where global_event_id = 'gdelt-https-check-test-1';

-- ---------------------------------------------------------------------------
-- 2. best_news_url — six adversarial inputs, each must trip
--    gdelt_event_cluster_best_news_url_https. Pair with
--    best_news_host set so best_news_coherent is satisfied.
-- ---------------------------------------------------------------------------
select pg_temp.expect_check_violation(
  $sql$ update public.gdelt_event_cluster
          set best_news_url = 'https://',
              best_news_host = 'placeholder.local'
          where global_event_id = 'gdelt-https-check-test-1' $sql$,
  'gdelt_event_cluster_best_news_url_https',
  'best_news_url: bare scheme'
);

select pg_temp.expect_check_violation(
  $sql$ update public.gdelt_event_cluster
          set best_news_url = 'https:// example.com/',
              best_news_host = 'example.com'
          where global_event_id = 'gdelt-https-check-test-1' $sql$,
  'gdelt_event_cluster_best_news_url_https',
  'best_news_url: whitespace after scheme'
);

select pg_temp.expect_check_violation(
  $sql$ update public.gdelt_event_cluster
          set best_news_url = 'https://attacker.com@internal.svc/',
              best_news_host = 'internal.svc'
          where global_event_id = 'gdelt-https-check-test-1' $sql$,
  'gdelt_event_cluster_best_news_url_https',
  'best_news_url: user@host credential-injection'
);

select pg_temp.expect_check_violation(
  $sql$ update public.gdelt_event_cluster
          set best_news_url = 'https://user:pass@example.com/',
              best_news_host = 'example.com'
          where global_event_id = 'gdelt-https-check-test-1' $sql$,
  'gdelt_event_cluster_best_news_url_https',
  'best_news_url: user:pass@host credential-injection'
);

select pg_temp.expect_check_violation(
  $sql$ update public.gdelt_event_cluster
          set best_news_url = 'https://example.com/a b',
              best_news_host = 'example.com'
          where global_event_id = 'gdelt-https-check-test-1' $sql$,
  'gdelt_event_cluster_best_news_url_https',
  'best_news_url: whitespace in path'
);

select pg_temp.expect_check_violation(
  format(
    $sql$ update public.gdelt_event_cluster
            set best_news_url = %L,
                best_news_host = 'example.com'
            where global_event_id = 'gdelt-https-check-test-1' $sql$,
    'https://example.com' || chr(13)
  ),
  'gdelt_event_cluster_best_news_url_https',
  'best_news_url: trailing CR'
);

-- best_news_url = NULL + best_news_host = NULL remains legal
-- (satisfies best_news_coherent; the new https CHECK is skipped on
-- NULL per standard CHECK semantics).
update public.gdelt_event_cluster
  set best_news_url = null,
      best_news_host = null
  where global_event_id = 'gdelt-https-check-test-1';

-- Well-formed best_news_url shapes must pass.
update public.gdelt_event_cluster
  set best_news_url = 'https://apnews.com/article/abc-123',
      best_news_host = 'apnews.com'
  where global_event_id = 'gdelt-https-check-test-1';

update public.gdelt_event_cluster
  set best_news_url = 'https://medium.com/@someuser',
      best_news_host = 'medium.com'
  where global_event_id = 'gdelt-https-check-test-1';

update public.gdelt_event_cluster
  set best_news_url = 'https://example.com?q=1',
      best_news_host = 'example.com'
  where global_event_id = 'gdelt-https-check-test-1';

update public.gdelt_event_cluster
  set best_news_url = 'https://example.com:8443/a',
      best_news_host = 'example.com'
  where global_event_id = 'gdelt-https-check-test-1';

update public.gdelt_event_cluster
  set best_news_url = 'https://example.com#frag',
      best_news_host = 'example.com'
  where global_event_id = 'gdelt-https-check-test-1';

-- ---------------------------------------------------------------------------
-- 3. outlet.url — six adversarial inputs, each must trip
--    gdelt_event_cluster_outlet_url_https.
-- ---------------------------------------------------------------------------
select pg_temp.expect_check_violation(
  $sql$ insert into public.gdelt_event_cluster_outlet
          (global_event_id, host, url)
          values ('gdelt-https-check-test-1', 'placeholder.local', 'https://') $sql$,
  'gdelt_event_cluster_outlet_url_https',
  'outlet.url: bare scheme'
);

select pg_temp.expect_check_violation(
  $sql$ insert into public.gdelt_event_cluster_outlet
          (global_event_id, host, url)
          values ('gdelt-https-check-test-1', 'example.com', 'https:// example.com/') $sql$,
  'gdelt_event_cluster_outlet_url_https',
  'outlet.url: whitespace after scheme'
);

select pg_temp.expect_check_violation(
  $sql$ insert into public.gdelt_event_cluster_outlet
          (global_event_id, host, url)
          values ('gdelt-https-check-test-1', 'internal.svc', 'https://attacker.com@internal.svc/') $sql$,
  'gdelt_event_cluster_outlet_url_https',
  'outlet.url: user@host credential-injection'
);

select pg_temp.expect_check_violation(
  $sql$ insert into public.gdelt_event_cluster_outlet
          (global_event_id, host, url)
          values ('gdelt-https-check-test-1', 'example.com', 'https://user:pass@example.com/') $sql$,
  'gdelt_event_cluster_outlet_url_https',
  'outlet.url: user:pass@host credential-injection'
);

select pg_temp.expect_check_violation(
  $sql$ insert into public.gdelt_event_cluster_outlet
          (global_event_id, host, url)
          values ('gdelt-https-check-test-1', 'example.com', 'https://example.com/a b') $sql$,
  'gdelt_event_cluster_outlet_url_https',
  'outlet.url: whitespace in path'
);

select pg_temp.expect_check_violation(
  format(
    $sql$ insert into public.gdelt_event_cluster_outlet
            (global_event_id, host, url)
            values ('gdelt-https-check-test-1', 'example.com', %L) $sql$,
    'https://example.com' || chr(13)
  ),
  'gdelt_event_cluster_outlet_url_https',
  'outlet.url: trailing CR'
);

-- A set of well-formed outlet rows must pass. Host is distinct per
-- row (composite PK on (global_event_id, host)).
insert into public.gdelt_event_cluster_outlet (global_event_id, host, url) values
  ('gdelt-https-check-test-1', 'apnews.com',    'https://apnews.com/article/abc-123'),
  ('gdelt-https-check-test-1', 'medium.com',    'https://medium.com/@someuser'),
  ('gdelt-https-check-test-1', 'q.example.com', 'https://example.com?q=1'),
  ('gdelt-https-check-test-1', 'p.example.com', 'https://example.com:8443/a'),
  ('gdelt-https-check-test-1', 'f.example.com', 'https://example.com#frag');

rollback;
