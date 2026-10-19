-- Behavioral test: record_drop_shadow_operator_pick (#265 push 2/3).
-- Covers the two guards added inside the RPC body:
--   1. NOT FOUND: calling with a drop_date that has no row raises
--      sqlstate no_data_found instead of silently discarding the
--      operator pick.
--   2. operator_notes length check: a notes value < 1 or > 4096
--      chars raises sqlstate check_violation at the RPC boundary.
-- A happy-path call on an existing row still succeeds and
-- populates the operator fields.
--
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file

begin;

create function pg_temp.expect_sqlstate(
  write_sql text, expected_sqlstate text, label text
) returns void
language plpgsql as $$
declare v_state text;
begin
  begin
    execute write_sql;
    raise exception 'expected sqlstate % for %, but call succeeded',
      expected_sqlstate, label;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state is distinct from expected_sqlstate then
      raise exception 'expected sqlstate %, got % for %',
        expected_sqlstate, v_state, label;
    end if;
  end;
end$$;

-- ---------------------------------------------------------------------------
-- A1. NOT FOUND: no row for drop_date, RPC raises no_data_found (02000).
-- ---------------------------------------------------------------------------
select pg_temp.expect_sqlstate(
  $sql$ select public.record_drop_shadow_operator_pick(
          '2026-01-01'::date,
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
          'notes'
        ) $sql$,
  '02000',
  'operator_pick: NOT FOUND on missing drop_date'
);

-- ---------------------------------------------------------------------------
-- Fixture: seed one shadow log row via the generator RPC so operator_pick
-- has something to UPDATE for the remaining cases.
-- ---------------------------------------------------------------------------
select public.record_drop_shadow_log(
  '2026-01-02'::date,
  null,
  '[]'::jsonb,
  '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- A2. operator_notes empty string: zero-length violates 1..4096.
-- ---------------------------------------------------------------------------
select pg_temp.expect_sqlstate(
  $sql$ select public.record_drop_shadow_operator_pick(
          '2026-01-02'::date,
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
          ''
        ) $sql$,
  '23514',
  'operator_pick: operator_notes empty string'
);

-- ---------------------------------------------------------------------------
-- A3. operator_notes too long: 4097 chars violates 1..4096.
-- ---------------------------------------------------------------------------
select pg_temp.expect_sqlstate(
  format(
    $sql$ select public.record_drop_shadow_operator_pick(
            '2026-01-02'::date,
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
            %L
          ) $sql$,
    repeat('x', 4097)
  ),
  '23514',
  'operator_pick: operator_notes 4097 chars'
);

-- ---------------------------------------------------------------------------
-- A4. Happy path: valid notes + existing row → row is updated.
-- ---------------------------------------------------------------------------
select public.record_drop_shadow_operator_pick(
  '2026-01-02'::date,
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,
  'operator rationale'
);

do $$
declare
  r public.drop_shadow_log%rowtype;
begin
  select * into r from public.drop_shadow_log where drop_date = '2026-01-02'::date;
  if r.operator_pick_candidate_id is distinct from
     'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid then
    raise exception 'operator_pick: happy-path candidate_id not persisted (got %)',
      r.operator_pick_candidate_id;
  end if;
  if r.operator_notes is distinct from 'operator rationale' then
    raise exception 'operator_pick: happy-path notes not persisted (got %)',
      r.operator_notes;
  end if;
  if r.operator_picked_at is null then
    raise exception 'operator_pick: operator_picked_at not stamped';
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- A5. NULL notes stays legal (nullable column; length guard skips).
-- ---------------------------------------------------------------------------
select public.record_drop_shadow_operator_pick(
  '2026-01-02'::date,
  'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid,
  null
);

rollback;

\echo record_drop_shadow_operator_pick.test.sql: ok
