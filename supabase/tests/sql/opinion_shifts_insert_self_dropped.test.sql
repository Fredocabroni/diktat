-- Behavioral test: opinion_shifts_insert_self policy is gone (#145 PR C,
-- migration 20261010100000). Verifies two things:
--   (a) authenticated INSERT via PostgREST-style client (no RPC) → 42501;
--   (b) RPC path (record_opinion_shift) still works end-to-end.
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file

begin;

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'd3333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated', 'd3@test.local', now(), now());

insert into public.news_topics (id, slug, headline, source_title, is_drop, drop_at) values
  ('33333333-aaaa-aaaa-aaaa-333333333333', 'rpc145-prc-test-topic', 'Test headline — #145 PR C', 'test', true, now());

-- -----------------------------------------------------------------------------
-- T1 — the policy must be gone. Enumerate pg_policies and assert there is no
-- row for (schemaname='public', tablename='opinion_shifts',
-- policyname='opinion_shifts_insert_self').
-- -----------------------------------------------------------------------------
do $$
declare
  v_policy_count integer;
begin
  select count(*)
    into v_policy_count
    from pg_policies
   where schemaname = 'public'
     and tablename = 'opinion_shifts'
     and policyname = 'opinion_shifts_insert_self';
  if v_policy_count <> 0 then
    raise exception 'T1 FAIL: opinion_shifts_insert_self policy still exists (count=%)', v_policy_count;
  end if;
  raise notice 'T1 PASS: opinion_shifts_insert_self is gone';
end $$;

-- -----------------------------------------------------------------------------
-- T2 — the SELECT policy stays. Users still need to read their own shifts
-- for the Take 5 UI and the change-of-mind affordance.
-- -----------------------------------------------------------------------------
do $$
declare
  v_policy_count integer;
begin
  select count(*)
    into v_policy_count
    from pg_policies
   where schemaname = 'public'
     and tablename = 'opinion_shifts'
     and policyname = 'opinion_shifts_select_self';
  if v_policy_count <> 1 then
    raise exception 'T2 FAIL: opinion_shifts_select_self missing (count=%)', v_policy_count;
  end if;
  raise notice 'T2 PASS: opinion_shifts_select_self stays';
end $$;

-- -----------------------------------------------------------------------------
-- T3 — direct INSERT as the `authenticated` role fails with 42501 or a
-- row-level-security violation. The role has to go through
-- record_opinion_shift now.
-- -----------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"d3333333-3333-3333-3333-333333333333","role":"authenticated"}';
set local role authenticated;

do $$
begin
  insert into public.opinion_shifts
    (user_id, topic_id, before_position, after_position, client_key)
  values
    ('d3333333-3333-3333-3333-333333333333',
     '33333333-aaaa-aaaa-aaaa-333333333333',
     0::smallint, 1::smallint,
     '44444444-4444-4444-4444-444444444444');
  raise exception 'T3 FAIL: direct INSERT as authenticated succeeded (policy drop did not land)';
exception
  when sqlstate '42501' then
    raise notice 'T3 PASS: direct INSERT as authenticated → 42501 (policy gone)';
  when insufficient_privilege then
    raise notice 'T3 PASS: direct INSERT as authenticated → insufficient_privilege (policy gone)';
end $$;

reset role;

-- -----------------------------------------------------------------------------
-- T4 — RPC path still works. record_opinion_shift (SECURITY DEFINER) is
-- unaffected by the policy drop; its grant is explicit and its body
-- writes directly.
-- -----------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"d3333333-3333-3333-3333-333333333333","role":"authenticated"}';

do $$
declare
  v_row public.opinion_shifts;
begin
  v_row := public.record_opinion_shift(
    p_topic_id       => '33333333-aaaa-aaaa-aaaa-333333333333',
    p_after_position => 1::smallint,
    p_client_key     => '55555555-5555-5555-5555-555555555555'
  );
  if v_row.id is null then
    raise exception 'T4 FAIL: RPC returned null row after policy drop';
  end if;
  if v_row.user_id <> 'd3333333-3333-3333-3333-333333333333' then
    raise exception 'T4 FAIL: user_id mismatch (got %)', v_row.user_id;
  end if;
  raise notice 'T4 PASS: record_opinion_shift still writes after policy drop';
end $$;

rollback;
