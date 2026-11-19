-- Behavioural tests for migration 20261203000000: moderation queue.
--
-- Runs as `postgres` (BYPASSRLS). Writes live inside a BEGIN..ROLLBACK
-- so nothing leaks out.
--
--   M1  admin_dismiss_report flips status + writes an audit row
--   M2  admin_hide_comment soft-deletes the comment, stamps actioned
--   M3  admin_ban_from_commenting inserts a ban + actions the report
--   M4  banned user's create_comment is refused with 23506
--   M5  unknown operator → operator_not_found
--   M6  authenticated role cannot execute the three admin RPCs

begin;

do $$
declare
  v_op uuid     := gen_random_uuid();
  v_user uuid   := gen_random_uuid();
  v_tid uuid    := gen_random_uuid();
  v_cid uuid;
  v_rid uuid;
begin
  insert into auth.users (id, email, encrypted_password, created_at, updated_at)
    values (v_op,   'mq-op@example.com',   '', now(), now()),
           (v_user, 'mq-user@example.com', '', now(), now());
  insert into public.users (id, handle, current_ap, age_verified_at)
    values (v_op,   ('mqop'   || substr(replace(v_op::text,'-',''),1,8))::extensions.citext,   100, now()),
           (v_user, ('mquser' || substr(replace(v_user::text,'-',''),1,8))::extensions.citext, 100, now())
    on conflict (id) do update set handle = excluded.handle, age_verified_at = excluded.age_verified_at;

  insert into public.news_topics (id, slug, headline, published_at, is_drop, drop_at)
    values (v_tid, ('mqt-' || substr(replace(v_tid::text,'-',''),1,8))::extensions.citext,
            'Test topic', now(), true, now());

  insert into public.opinion_shifts (user_id, topic_id, before_position, after_position, created_at)
    values (v_user, v_tid, 0, 1, now());

  insert into public.comments (topic_id, parent_id, user_id, handle, stance, body)
    values (v_tid, null, v_user,
            (select handle from public.users where id = v_user), 'agree', 'hello world')
    returning id into v_cid;

  insert into public.reports (reporter_user_id, target_type, target_id, reason)
    values (v_op, 'drop', v_tid, 'spam')
    returning id into v_rid;

  perform set_config('tests.mq_op',   v_op::text,   true);
  perform set_config('tests.mq_user', v_user::text, true);
  perform set_config('tests.mq_tid',  v_tid::text,  true);
  perform set_config('tests.mq_cid',  v_cid::text,  true);
  perform set_config('tests.mq_rid',  v_rid::text,  true);
end $$;

-- M1 — dismiss flips status, writes audit row.
do $$
declare
  v_op  uuid := current_setting('tests.mq_op')::uuid;
  v_rid uuid := current_setting('tests.mq_rid')::uuid;
  v_res jsonb;
  v_status text;
  v_audit int;
begin
  v_res := public.admin_dismiss_report(v_op, v_rid);
  if v_res->>'outcome' <> 'dismissed' then
    raise exception 'M1 FAIL: outcome = %', v_res;
  end if;
  select status into v_status from public.reports where id = v_rid;
  if v_status <> 'dismissed' then
    raise exception 'M1 FAIL: status = %', v_status;
  end if;
  select count(*) into v_audit from public.moderation_audit_log
    where operator_id = v_op and report_id = v_rid and action = 'dismiss_report';
  if v_audit <> 1 then
    raise exception 'M1 FAIL: expected 1 audit row, got %', v_audit;
  end if;
  raise notice 'M1 PASS';
end $$;

-- M2 — hide_comment soft-deletes + marks report actioned.
do $$
declare
  v_op  uuid := current_setting('tests.mq_op')::uuid;
  v_cid uuid := current_setting('tests.mq_cid')::uuid;
  v_user uuid := current_setting('tests.mq_user')::uuid;
  v_rid2 uuid;
  v_del  timestamptz;
  v_body text;
  v_status text;
begin
  -- target_id is not FK'd; a synthetic uuid avoids the reporter+target
  -- unique collision with the M1 fixture.
  insert into public.reports (reporter_user_id, target_type, target_id, reason)
    values (v_op, 'drop', gen_random_uuid(), 'spam2')
    returning id into v_rid2;

  perform public.admin_hide_comment(v_op, v_cid, v_rid2);
  select deleted_at, body into v_del, v_body from public.comments where id = v_cid;
  if v_del is null or v_body <> '' then
    raise exception 'M2 FAIL: deleted_at=% body=%', v_del, v_body;
  end if;
  select status into v_status from public.reports where id = v_rid2;
  if v_status <> 'actioned' then
    raise exception 'M2 FAIL: report status = %', v_status;
  end if;
  raise notice 'M2 PASS';
end $$;

-- M3 — ban_from_commenting inserts a ban + actions the report.
do $$
declare
  v_op   uuid := current_setting('tests.mq_op')::uuid;
  v_user uuid := current_setting('tests.mq_user')::uuid;
  v_rid3 uuid;
  v_banned_count int;
  v_status text;
begin
  insert into public.reports (reporter_user_id, target_type, target_id, reason)
    values (v_op, 'drop', gen_random_uuid(), 'spam3')
    returning id into v_rid3;

  perform public.admin_ban_from_commenting(v_op, v_user, 'abuse', v_rid3);
  select count(*) into v_banned_count from public.comment_bans where user_id = v_user;
  if v_banned_count <> 1 then
    raise exception 'M3 FAIL: expected 1 ban row, got %', v_banned_count;
  end if;
  select status into v_status from public.reports where id = v_rid3;
  if v_status <> 'actioned' then
    raise exception 'M3 FAIL: report status = %', v_status;
  end if;
  raise notice 'M3 PASS';
end $$;

-- M4 — the BEFORE INSERT trigger refuses a direct insert by a banned
-- user with 23506. Using a direct INSERT (rather than create_comment)
-- keeps this test independent of any create_comment migration variant.
do $$
declare
  v_user uuid := current_setting('tests.mq_user')::uuid;
  v_tid  uuid := current_setting('tests.mq_tid')::uuid;
  v_handle extensions.citext;
  v_caught text;
begin
  select handle into v_handle from public.users where id = v_user;
  begin
    insert into public.comments (topic_id, parent_id, user_id, handle, stance, body)
      values (v_tid, null, v_user, v_handle, 'agree', 'banned user direct insert');
    raise exception 'M4 FAIL: expected 23506, got success';
  exception when restrict_violation then
    v_caught := SQLERRM;
    if position('user_banned' in v_caught) = 0 then
      raise exception 'M4 FAIL: expected user_banned, got "%"', v_caught;
    end if;
  end;
  raise notice 'M4 PASS';
end $$;

-- M5 — unknown operator rejected.
do $$
declare
  v_rid uuid := current_setting('tests.mq_rid')::uuid;
  v_caught text;
begin
  begin
    perform public.admin_dismiss_report(gen_random_uuid(), v_rid);
    raise exception 'M5 FAIL: expected operator_not_found, got success';
  exception when raise_exception then
    v_caught := SQLERRM;
    if position('operator_not_found' in v_caught) = 0 then
      raise exception 'M5 FAIL: wrong message "%"', v_caught;
    end if;
  end;
  raise notice 'M5 PASS';
end $$;

-- M6 — authenticated role cannot execute the admin RPCs.
do $$
declare
  v_denied int := 0;
begin
  set local role authenticated;
  begin
    perform public.admin_dismiss_report(gen_random_uuid(), gen_random_uuid());
  exception when insufficient_privilege then
    v_denied := v_denied + 1;
  end;
  begin
    perform public.admin_hide_comment(gen_random_uuid(), gen_random_uuid(), null);
  exception when insufficient_privilege then
    v_denied := v_denied + 1;
  end;
  begin
    perform public.admin_ban_from_commenting(gen_random_uuid(), gen_random_uuid(), 'x', null);
  exception when insufficient_privilege then
    v_denied := v_denied + 1;
  end;
  reset role;
  if v_denied <> 3 then
    raise exception 'M6 FAIL: expected 3 denials, got %', v_denied;
  end if;
  raise notice 'M6 PASS';
end $$;

rollback;
\echo 'ALL moderation_queue ASSERTIONS PASSED (M1-M6)'
