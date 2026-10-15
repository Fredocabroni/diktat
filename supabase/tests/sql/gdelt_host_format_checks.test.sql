-- Behavioral test: #215 LOW 2 — host-format CHECK on the three
-- GDELT host columns.
--
-- One negative case per adversarial shape, per column; the harness
-- asserts the SPECIFIC `_host_format` constraint is what rejects.
-- A future loosening (e.g. someone widens the regex to accept
-- whitespace) will fall through to primary_tier_coherent or
-- best_news_coherent and be caught by the constraint-name assertion.
--
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file

begin;

create function pg_temp.expect_check_violation(
  write_sql text, expected_constraint text, label text
) returns void
language plpgsql as $$
declare v_constraint text;
begin
  begin
    execute write_sql;
    raise exception 'expected check_violation on constraint % for %, but write succeeded',
      expected_constraint, label;
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from expected_constraint then
      raise exception 'expected %, got % for %',
        expected_constraint, v_constraint, label;
    end if;
  end;
end$$;

-- ---------------------------------------------------------------------------
-- Fixture: minimal cluster row with primary_url NULL (so the primary
-- host CHECK is the only one that can fire on an UPDATE that sets
-- primary_host alone — paired with primary_url + primary_tier so
-- primary_tier_coherent passes).
-- ---------------------------------------------------------------------------
insert into public.gdelt_event_cluster (global_event_id)
values ('host-format-test-1');

-- ---------------------------------------------------------------------------
-- 1. primary_host — adversarial inputs.
-- ---------------------------------------------------------------------------
select pg_temp.expect_check_violation(
  $sql$ update public.gdelt_event_cluster
          set primary_url = 'https://example.com/x',
              primary_host = 'ex ample.com',
              primary_tier = 'primary'
          where global_event_id = 'host-format-test-1' $sql$,
  'gdelt_event_cluster_primary_host_format',
  'primary_host: whitespace'
);

select pg_temp.expect_check_violation(
  format(
    $sql$ update public.gdelt_event_cluster
            set primary_url = 'https://example.com/x',
                primary_host = %L,
                primary_tier = 'primary'
            where global_event_id = 'host-format-test-1' $sql$,
    'example.com' || chr(0)
  ),
  'gdelt_event_cluster_primary_host_format',
  'primary_host: trailing null byte'
);

select pg_temp.expect_check_violation(
  $sql$ update public.gdelt_event_cluster
          set primary_url = 'https://example.com/x',
              primary_host = 'EXAMPLE.COM',
              primary_tier = 'primary'
          where global_event_id = 'host-format-test-1' $sql$,
  'gdelt_event_cluster_primary_host_format',
  'primary_host: uppercase (TS normalizeHost already lowers)'
);

-- A well-formed primary_host passes.
update public.gdelt_event_cluster
  set primary_url = 'https://supremecourt.gov/opinions',
      primary_host = 'supremecourt.gov',
      primary_tier = 'primary'
  where global_event_id = 'host-format-test-1';

-- Reset for best_news_host assertions.
update public.gdelt_event_cluster
  set primary_url = null, primary_host = null, primary_tier = null
  where global_event_id = 'host-format-test-1';

-- ---------------------------------------------------------------------------
-- 2. best_news_host — adversarial inputs.
-- ---------------------------------------------------------------------------
select pg_temp.expect_check_violation(
  $sql$ update public.gdelt_event_cluster
          set best_news_url = 'https://example.com/x',
              best_news_host = 'ex ample.com'
          where global_event_id = 'host-format-test-1' $sql$,
  'gdelt_event_cluster_best_news_host_format',
  'best_news_host: whitespace'
);

select pg_temp.expect_check_violation(
  format(
    $sql$ update public.gdelt_event_cluster
            set best_news_url = 'https://example.com/x',
                best_news_host = %L
            where global_event_id = 'host-format-test-1' $sql$,
    'exa' || chr(13) || 'mple.com'
  ),
  'gdelt_event_cluster_best_news_host_format',
  'best_news_host: embedded CR'
);

-- NULL stays legal.
update public.gdelt_event_cluster
  set best_news_url = null, best_news_host = null
  where global_event_id = 'host-format-test-1';

-- Well-formed shape passes.
update public.gdelt_event_cluster
  set best_news_url = 'https://apnews.com/story',
      best_news_host = 'apnews.com'
  where global_event_id = 'host-format-test-1';

-- ---------------------------------------------------------------------------
-- 3. outlet.host — adversarial inputs.
-- ---------------------------------------------------------------------------
select pg_temp.expect_check_violation(
  $sql$ insert into public.gdelt_event_cluster_outlet (global_event_id, host, url)
          values ('host-format-test-1', 'ex ample.com', 'https://example.com/x') $sql$,
  'gdelt_event_cluster_outlet_host_format',
  'outlet.host: whitespace'
);

select pg_temp.expect_check_violation(
  $sql$ insert into public.gdelt_event_cluster_outlet (global_event_id, host, url)
          values ('host-format-test-1', '', 'https://example.com/y') $sql$,
  'gdelt_event_cluster_outlet_host_format',
  'outlet.host: empty string'
);

select pg_temp.expect_check_violation(
  $sql$ insert into public.gdelt_event_cluster_outlet (global_event_id, host, url)
          values ('host-format-test-1', '-example.com', 'https://example.com/z') $sql$,
  'gdelt_event_cluster_outlet_host_format',
  'outlet.host: starts with hyphen'
);

-- Well-formed outlet row passes.
insert into public.gdelt_event_cluster_outlet (global_event_id, host, url)
  values ('host-format-test-1', 'reuters.com', 'https://reuters.com/story');

rollback;
