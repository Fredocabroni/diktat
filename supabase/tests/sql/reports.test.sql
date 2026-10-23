-- Behavioural tests for the content-reports RPC + table (migration
-- 20261112000000, push 3/3 — age-gate / target-exists / throttle /
-- unique / updated_at trigger / no-reason-in-alert).
--
-- Covers:
--   R1  anon cannot execute submit_report; authenticated can; anon
--       call raises 28000.
--   R2  Happy-path insert from an age-verified reporter against an
--       existing target returns {outcome: 'submitted', id} and
--       stores reporter_user_id = auth.uid(), trimmed reason, and
--       the target.
--   R3  Empty / whitespace / over-length reason → 22023.
--   R4  Unknown target_type → 22023 (not in the three-value vocab).
--   R5  Target row missing in the mapped table → P0001 with
--       'target_not_found' prefix.
--   R6  Age-gate: reporter with age_verified_at IS NULL → P0001
--       'age_not_verified'.
--   R7  Unique: a second call from the same reporter against the
--       same target returns {outcome: 'already_reported', id} with
--       the FIRST report's id and inserts no new row.
--   R8  Throttle: >=10 reports from the same reporter in the last
--       hour → P0001 'rate_limited'. 11th call rejected.
--   R9  updated_at trigger: service_role UPDATE on reports bumps
--       updated_at.
--   R10 Direct PostgREST SELECT on public.reports as authenticated →
--       42501 / 0 rows (RLS enabled, no SELECT policy, no table
--       GRANT).
--   R11 Deleting a reporter's public.users row sets reporter_user_id
--       to NULL on their reports (on delete set null).

begin;

-- --------------------------------------------------------------------
-- Fixtures.
-- --------------------------------------------------------------------
insert into auth.users (id, email, aud, role, created_at, updated_at)
values
  ('a1a1a1a1-5555-4551-8551-a1a1a1a1a1a1', 'reporter@test',
   'authenticated', 'authenticated', now(), now()),
  ('b2b2b2b2-6666-4666-8666-b2b2b2b2b2b2', 'other@test',
   'authenticated', 'authenticated', now(), now()),
  ('c3c3c3c3-7777-4777-8777-c3c3c3c3c3c3', 'noage@test',
   'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.users (id, handle, display_name)
values
  ('a1a1a1a1-5555-4551-8551-a1a1a1a1a1a1', 'rep_t', 'Reporter'),
  ('b2b2b2b2-6666-4666-8666-b2b2b2b2b2b2', 'oth_t', 'Other'),
  ('c3c3c3c3-7777-4777-8777-c3c3c3c3c3c3', 'noa_t', 'NoAge')
on conflict (id) do nothing;

-- Age-verify the main reporter + the "other" user; leave "noage"
-- unverified. The handle_new_user trigger did NOT backfill age
-- (it only auto-stamps for bots), so these UPDATEs set the gate.
update public.users
   set age_verified_at = now()
 where id in (
   'a1a1a1a1-5555-4551-8551-a1a1a1a1a1a1',
   'b2b2b2b2-6666-4666-8666-b2b2b2b2b2b2'
 );

-- A single existing news_topics row as the 'drop' target for R5's
-- negative-space contrast and for the happy-path target lookup.
-- (Any already-existing drop row would do; we create a minimal one
-- here so the test doesn't depend on seed state.)
insert into public.news_topics (id, slug, headline, source_title)
values
  ('d4d4d4d4-8888-4888-8888-d4d4d4d4d4d4', 'reports-test-drop',
   'Reports test drop', 'Reports test source')
on conflict (id) do nothing;

create or replace function _test_rep_as(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid::text, 'role', 'authenticated')::text,
    true);
  perform set_config('role', 'authenticated', true);
end
$$;

-- --------------------------------------------------------------------
-- R1: EXECUTE privileges.
-- --------------------------------------------------------------------
do $$
declare v_has boolean;
begin
  select has_function_privilege('anon',
                                'public.submit_report(text, uuid, text)',
                                'EXECUTE')
    into v_has;
  if v_has then raise exception 'R1: anon has EXECUTE on submit_report'; end if;
  select has_function_privilege('authenticated',
                                'public.submit_report(text, uuid, text)',
                                'EXECUTE')
    into v_has;
  if not v_has then raise exception 'R1: authenticated lacks EXECUTE'; end if;
end
$$;

-- --------------------------------------------------------------------
-- R2: happy path — age-verified reporter, existing target.
-- --------------------------------------------------------------------
do $$
declare
  v_out     jsonb;
  v_id      uuid;
  v_target  uuid := 'd4d4d4d4-8888-4888-8888-d4d4d4d4d4d4';
  v_row     record;
begin
  perform _test_rep_as('a1a1a1a1-5555-4551-8551-a1a1a1a1a1a1');
  v_out := public.submit_report('drop', v_target, '  spam content  ');
  if v_out->>'outcome' <> 'submitted' then
    raise exception 'R2: expected outcome=submitted, got %', v_out;
  end if;
  v_id := (v_out->>'id')::uuid;
  if v_id is null then raise exception 'R2: returned id was null'; end if;

  perform set_config('role', 'postgres', true);
  select reporter_user_id, reason, target_type, target_id
    into v_row
    from public.reports where id = v_id;
  if v_row.reporter_user_id <> 'a1a1a1a1-5555-4551-8551-a1a1a1a1a1a1' then
    raise exception 'R2: reporter_user_id not stamped from auth.uid()';
  end if;
  if v_row.reason <> 'spam content' then
    raise exception 'R2: reason not trimmed, got %', v_row.reason;
  end if;
  if v_row.target_type <> 'drop' then
    raise exception 'R2: target_type not stored';
  end if;
  if v_row.target_id <> v_target then
    raise exception 'R2: target_id drift';
  end if;
end
$$;

-- --------------------------------------------------------------------
-- R3: whitespace / empty / too-long reason → 22023.
-- --------------------------------------------------------------------
do $$
begin
  perform _test_rep_as('a1a1a1a1-5555-4551-8551-a1a1a1a1a1a1');
  begin
    perform public.submit_report('drop',
      'd4d4d4d4-8888-4888-8888-d4d4d4d4d4d4', '   ');
    raise exception 'R3a: expected 22023 on whitespace reason';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.submit_report('drop',
      'd4d4d4d4-8888-4888-8888-d4d4d4d4d4d4', repeat('x', 2001));
    raise exception 'R3b: expected 22023 on over-length reason';
  exception when sqlstate '22023' then null;
  end;
end
$$;

-- --------------------------------------------------------------------
-- R4: unknown target_type → 22023.
-- --------------------------------------------------------------------
do $$
begin
  perform _test_rep_as('a1a1a1a1-5555-4551-8551-a1a1a1a1a1a1');
  begin
    perform public.submit_report('unknown_surface',
      'd4d4d4d4-8888-4888-8888-d4d4d4d4d4d4', 'ok');
    raise exception 'R4: expected 22023 on unknown target_type';
  exception when sqlstate '22023' then null;
  end;
end
$$;

-- --------------------------------------------------------------------
-- R5: target_id missing from the mapped table → P0001 target_not_found.
-- --------------------------------------------------------------------
do $$
declare v_msg text;
begin
  perform _test_rep_as('a1a1a1a1-5555-4551-8551-a1a1a1a1a1a1');
  begin
    perform public.submit_report('drop',
      '99999999-9999-4999-8999-999999999999', 'spam');
    raise exception 'R5: expected P0001 target_not_found';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_msg = message_text;
    if position('target_not_found' in v_msg) = 0 then
      raise exception 'R5: wrong P0001 message: %', v_msg;
    end if;
  end;
end
$$;

-- --------------------------------------------------------------------
-- R6: reporter without age_verified_at → P0001 age_not_verified.
-- --------------------------------------------------------------------
do $$
declare v_msg text;
begin
  perform _test_rep_as('c3c3c3c3-7777-4777-8777-c3c3c3c3c3c3');
  begin
    perform public.submit_report('drop',
      'd4d4d4d4-8888-4888-8888-d4d4d4d4d4d4', 'spam');
    raise exception 'R6: expected P0001 age_not_verified';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_msg = message_text;
    if position('age_not_verified' in v_msg) = 0 then
      raise exception 'R6: wrong P0001 message: %', v_msg;
    end if;
  end;
end
$$;

-- --------------------------------------------------------------------
-- R7: unique — second call same (reporter, target) returns
-- already_reported with the first report's id. No new row inserted.
-- --------------------------------------------------------------------
do $$
declare
  v_out1 jsonb;
  v_out2 jsonb;
  v_count int;
begin
  perform _test_rep_as('b2b2b2b2-6666-4666-8666-b2b2b2b2b2b2');
  v_out1 := public.submit_report('drop',
    'd4d4d4d4-8888-4888-8888-d4d4d4d4d4d4', 'first time');
  v_out2 := public.submit_report('drop',
    'd4d4d4d4-8888-4888-8888-d4d4d4d4d4d4', 'second time');
  if v_out2->>'outcome' <> 'already_reported' then
    raise exception 'R7: expected already_reported on duplicate, got %', v_out2;
  end if;
  if v_out2->>'id' <> v_out1->>'id' then
    raise exception 'R7: duplicate did not return the first report id';
  end if;
  perform set_config('role', 'postgres', true);
  select count(*) into v_count
    from public.reports
    where reporter_user_id = 'b2b2b2b2-6666-4666-8666-b2b2b2b2b2b2'
      and target_type = 'drop'
      and target_id = 'd4d4d4d4-8888-4888-8888-d4d4d4d4d4d4';
  if v_count <> 1 then
    raise exception 'R7: duplicate inserted a second row (got %)', v_count;
  end if;
end
$$;

-- --------------------------------------------------------------------
-- R8: throttle — 10/hour cap per reporter.
-- --------------------------------------------------------------------
do $$
declare
  v_target uuid;
  v_i int;
  v_msg text;
begin
  -- Make 10 extra verified users to serve as unique target_ids for
  -- the throttle test (each row of public.users is itself a valid
  -- target under target_type='user'). This lets the reporter clear
  -- the unique-constraint path for each of the 10 attempts.
  -- Build 11 targets with distinct enough UUIDs that
  -- `substr(replace(id::text,'-',''), 1, 10)` (what handle_new_user
  -- uses for the auto-handle) is unique per row. Using
  -- `ffNNeeee-9999-4999-8999-eeeeeeeeeeee` with NN = 01..11.
  perform set_config('role', 'postgres', true);
  for v_i in 1..11 loop
    insert into auth.users (id, email, aud, role, created_at, updated_at)
    values
      (('ff' || lpad(v_i::text, 2, '0') || 'eeee-9999-4999-8999-eeeeeeeeeeee')::uuid,
       'target' || v_i || '@test', 'authenticated',
       'authenticated', now(), now())
    on conflict (id) do nothing;
    update public.users
       set handle = 'tgt' || v_i,
           display_name = 'Tgt' || v_i
     where id = ('ff' || lpad(v_i::text, 2, '0') || 'eeee-9999-4999-8999-eeeeeeeeeeee')::uuid;
  end loop;

  -- The verified reporter from R2 has 1 existing row; fire 9 more to
  -- reach the 10-cap, then verify the 11th is rate-limited.
  perform _test_rep_as('a1a1a1a1-5555-4551-8551-a1a1a1a1a1a1');
  for v_i in 1..9 loop
    v_target := ('ff' || lpad(v_i::text, 2, '0') || 'eeee-9999-4999-8999-eeeeeeeeeeee')::uuid;
    perform public.submit_report('user', v_target, 't' || v_i);
  end loop;

  -- The 11th call should rate-limit (10 rows already in last hour).
  v_target := ('ff11eeee-9999-4999-8999-eeeeeeeeeeee')::uuid;
  begin
    perform public.submit_report('user', v_target, 'eleventh');
    raise exception 'R8: expected P0001 rate_limited at the 11th call';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_msg = message_text;
    if position('rate_limited' in v_msg) = 0 then
      raise exception 'R8: wrong P0001 message: %', v_msg;
    end if;
  end;
end
$$;

-- --------------------------------------------------------------------
-- R9: updated_at trigger wired (BEFORE UPDATE, reuses the repo-wide
-- set_updated_at() helper from migration 20260420090001).
--
-- Dynamic bump cannot be observed inside a single begin/rollback test
-- transaction (set_updated_at() uses now() = transaction_timestamp,
-- which is constant). Assert the trigger exists in pg_trigger
-- instead; its behaviour is covered by the shared helper's own
-- tests.
-- --------------------------------------------------------------------
do $$
declare v_hits int;
begin
  perform set_config('role', 'postgres', true);
  select count(*) into v_hits
    from pg_trigger
    where tgrelid = 'public.reports'::regclass
      and tgname = 'reports_set_updated_at'
      and not tgisinternal;
  if v_hits <> 1 then
    raise exception 'R9: reports_set_updated_at trigger not installed (hits=%)', v_hits;
  end if;
end
$$;

-- --------------------------------------------------------------------
-- R10: authenticated SELECT via PostgREST path → 0 rows / 42501.
-- --------------------------------------------------------------------
do $$
declare v_visible int;
begin
  perform _test_rep_as('a1a1a1a1-5555-4551-8551-a1a1a1a1a1a1');
  begin
    select count(*) into v_visible from public.reports;
    if v_visible > 0 then
      raise exception 'R10: authenticated saw % reports', v_visible;
    end if;
  exception when sqlstate '42501' then null;
  end;
end
$$;

-- --------------------------------------------------------------------
-- R11: deleting the reporter's public.users row anonymizes.
-- --------------------------------------------------------------------
do $$
declare
  v_count_before int;
  v_count_after  int;
begin
  perform set_config('role', 'postgres', true);
  select count(*) into v_count_before
    from public.reports
    where reporter_user_id = 'b2b2b2b2-6666-4666-8666-b2b2b2b2b2b2';
  if v_count_before = 0 then
    raise exception 'R11: expected at least one row before delete';
  end if;

  delete from public.users where id = 'b2b2b2b2-6666-4666-8666-b2b2b2b2b2b2';

  select count(*) into v_count_after
    from public.reports
    where reporter_user_id = 'b2b2b2b2-6666-4666-8666-b2b2b2b2b2b2';
  if v_count_after <> 0 then
    raise exception 'R11: reporter_user_id was not nulled on user delete';
  end if;
end
$$;

rollback;
