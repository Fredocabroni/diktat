-- Behavioural tests for the content-reports RPC + table (migration
-- 20261112000000). Covers:
--   R1  anon cannot execute submit_report; authenticated can.
--   R2  Submitting as auth user inserts with reporter_user_id =
--       auth.uid() and the trimmed reason + stamped target.
--   R3  Empty / whitespace-only reason → 22023.
--   R4  Over-length reason → 22023.
--   R5  Unknown target_type → 22023.
--   R6  Not authenticated → 28000.
--   R7  Direct PostgREST SELECT on public.reports as authenticated →
--       returns zero rows (RLS enabled, no SELECT policy; service_role
--       only reads).
--   R8  Deleting a reporter's public.users row sets reporter_user_id
--       to NULL on their reports (on delete set null).

begin;

insert into auth.users (id, email, aud, role, created_at, updated_at)
values
  ('a1a1a1a1-5555-4551-8551-a1a1a1a1a1a1', 'reporter@test', 'authenticated',
   'authenticated', now(), now()),
  ('b2b2b2b2-6666-4666-8666-b2b2b2b2b2b2', 'other@test', 'authenticated',
   'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.users (id, handle, display_name)
values
  ('a1a1a1a1-5555-4551-8551-a1a1a1a1a1a1', 'rep_t', 'Reporter'),
  ('b2b2b2b2-6666-4666-8666-b2b2b2b2b2b2', 'oth_t', 'Other')
on conflict (id) do nothing;

create or replace function _test_rep_as(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid::text, 'role', 'authenticated')::text,
    true);
  perform set_config('role', 'authenticated', true);
end
$$;

-- R1: EXECUTE privileges.
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

-- R2: happy path.
do $$
declare
  v_id         uuid;
  v_target     uuid := '00000000-0000-4000-8000-000000000001';
  v_row_count  int;
  v_reporter   uuid;
  v_reason     text;
  v_target_t   text;
begin
  perform _test_rep_as('a1a1a1a1-5555-4551-8551-a1a1a1a1a1a1');
  v_id := public.submit_report('debate_arg', v_target, '  spam content  ');
  if v_id is null then raise exception 'R2: expected a returned id'; end if;

  perform set_config('role', 'postgres', true);
  select count(*), reporter_user_id, reason, target_type
    into v_row_count, v_reporter, v_reason, v_target_t
    from public.reports
    where id = v_id
    group by reporter_user_id, reason, target_type;
  if v_row_count <> 1 then raise exception 'R2: row not inserted'; end if;
  if v_reporter <> 'a1a1a1a1-5555-4551-8551-a1a1a1a1a1a1' then
    raise exception 'R2: reporter_user_id not stamped from auth.uid()';
  end if;
  if v_reason <> 'spam content' then
    raise exception 'R2: reason not trimmed, got %', v_reason;
  end if;
  if v_target_t <> 'debate_arg' then
    raise exception 'R2: target_type not stored';
  end if;
end
$$;

-- R3: whitespace-only reason → 22023.
do $$
begin
  perform _test_rep_as('a1a1a1a1-5555-4551-8551-a1a1a1a1a1a1');
  begin
    perform public.submit_report(
      'debate_arg',
      '00000000-0000-4000-8000-000000000002',
      '   '
    );
    raise exception 'R3: expected 22023 on whitespace reason';
  exception when sqlstate '22023' then
    null;
  end;
end
$$;

-- R4: over-length reason → 22023.
do $$
begin
  perform _test_rep_as('a1a1a1a1-5555-4551-8551-a1a1a1a1a1a1');
  begin
    perform public.submit_report(
      'debate_arg',
      '00000000-0000-4000-8000-000000000003',
      repeat('x', 2001)
    );
    raise exception 'R4: expected 22023 on 2001-char reason';
  exception when sqlstate '22023' then
    null;
  end;
end
$$;

-- R5: unknown target_type → 22023.
do $$
begin
  perform _test_rep_as('a1a1a1a1-5555-4551-8551-a1a1a1a1a1a1');
  begin
    perform public.submit_report(
      'unknown_surface',
      '00000000-0000-4000-8000-000000000004',
      'ok'
    );
    raise exception 'R5: expected 22023 on unknown target_type';
  exception when sqlstate '22023' then
    null;
  end;
end
$$;

-- R6: anon → 28000.
do $$
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.submit_report(
      'debate_arg',
      '00000000-0000-4000-8000-000000000005',
      'ok'
    );
    raise exception 'R6: expected 28000 on anon';
  exception when sqlstate '28000' then
    null;
  end;
end
$$;

-- R7: authenticated SELECT via PostgREST path → 0 rows (RLS enabled,
-- no SELECT policy, no table GRANT to authenticated).
do $$
declare v_visible int;
begin
  perform _test_rep_as('a1a1a1a1-5555-4551-8551-a1a1a1a1a1a1');
  begin
    select count(*) into v_visible from public.reports;
    -- With RLS on + no policy + no GRANT, the role has no privilege
    -- for the table. Either 42501 (no privilege) or 0 rows are both
    -- "the user cannot see anything".
    if v_visible > 0 then
      raise exception 'R7: authenticated saw % reports via PostgREST', v_visible;
    end if;
  exception when sqlstate '42501' then
    null; -- expected
  end;
end
$$;

-- R8: deleting the reporter's public.users row anonymizes their reports.
do $$
declare
  v_id uuid;
  v_reporter_after uuid;
begin
  perform _test_rep_as('b2b2b2b2-6666-4666-8666-b2b2b2b2b2b2');
  v_id := public.submit_report(
    'debate_arg',
    '00000000-0000-4000-8000-000000000006',
    'from the other user'
  );
  perform set_config('role', 'postgres', true);
  delete from public.users where id = 'b2b2b2b2-6666-4666-8666-b2b2b2b2b2b2';
  select reporter_user_id into v_reporter_after
    from public.reports where id = v_id;
  if v_reporter_after is not null then
    raise exception 'R8: reporter_user_id was NOT set null on user delete';
  end if;
end
$$;

rollback;
