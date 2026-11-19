-- Behavioural tests for migration 20261202000000: comment_safety_precheck.
--
-- Covers the pre-write doxxing filter injected into create_comment.
-- Runs as `postgres` (BYPASSRLS) so we can seed fixtures directly.
-- Mutations live inside a single BEGIN..ROLLBACK so nothing leaks
-- out of the test transaction.
--
--   C1  SSN-shaped body    → 23514 'comments: body_blocked_doxxing_ssn'
--   C2  phone-shaped body  → 23514 'comments: body_blocked_doxxing_phone'
--   C3  cc-shaped body     → 23514 'comments: body_blocked_doxxing_cc'
--   C4  normal body        → insert succeeds
--   C5  disabled pattern   → match ignored, insert succeeds
--   C6  operator wordlist  → custom reason label surfaces in exception

begin;

-- Fixtures: a user with a locked stance on a topic.
do $$
declare
  v_uid uuid := gen_random_uuid();
  v_tid uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, encrypted_password, created_at, updated_at)
    values (v_uid, 'cx-safety@example.com', '', now(), now());
  insert into public.users (id, handle, current_ap, created_at)
    values (v_uid, ('cx' || substr(replace(v_uid::text, '-', ''), 1, 8))::extensions.citext, 100, now())
    on conflict (id) do update set handle = excluded.handle;
  insert into public.news_topics (id, slug, headline, published_at, is_drop, drop_at)
    values (v_tid, ('cx-topic-' || substr(replace(v_tid::text, '-', ''), 1, 8))::extensions.citext, 'Test topic', now(), true, now());
  insert into public.opinion_shifts (user_id, topic_id, before_position, after_position, created_at)
    values (v_uid, v_tid, 0, 1, now());
  perform set_config('tests.cx_uid', v_uid::text, true);
  perform set_config('tests.cx_tid', v_tid::text, true);
end $$;

-- Helper: call create_comment as the fixture user. Uses JIT auth.uid()
-- override via the request.jwt.claims GUC the same way attest_age.test.sql
-- does.
create or replace function pg_temp.cx_create(p_body text)
returns text
language plpgsql
as $$
declare
  v_uid uuid := current_setting('tests.cx_uid')::uuid;
  v_tid uuid := current_setting('tests.cx_tid')::uuid;
  v_rec record;
begin
  -- create_comment reads auth.uid() → the 'sub' claim. Role switch is
  -- unnecessary (the RPC is SECURITY DEFINER and this test runs
  -- against a pg_temp helper the authenticated role can't execute).
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text,
    true);
  select * into v_rec from public.create_comment(v_tid, null, p_body);
  return v_rec.id::text;
end $$;

-- C1 — SSN shape rejected.
do $$
declare
  v_caught text;
begin
  begin
    perform pg_temp.cx_create('leaking ssn 123-45-6789 here');
    raise exception 'C1 FAIL: expected 23514, got success';
  exception when check_violation then
    v_caught := SQLERRM;
    if position('body_blocked_doxxing_ssn' in v_caught) = 0 then
      raise exception 'C1 FAIL: expected body_blocked_doxxing_ssn, got "%"', v_caught;
    end if;
  end;
end $$;

-- C2 — phone shape rejected.
do $$
declare
  v_caught text;
begin
  begin
    perform pg_temp.cx_create('call me at (555) 123-4567 any time');
    raise exception 'C2 FAIL: expected 23514, got success';
  exception when check_violation then
    v_caught := SQLERRM;
    if position('body_blocked_doxxing_phone' in v_caught) = 0 then
      raise exception 'C2 FAIL: expected body_blocked_doxxing_phone, got "%"', v_caught;
    end if;
  end;
end $$;

-- C3 — credit-card shape rejected (16-digit run).
do $$
declare
  v_caught text;
begin
  begin
    perform pg_temp.cx_create('card 4111 1111 1111 1111 nope');
    raise exception 'C3 FAIL: expected 23514, got success';
  exception when check_violation then
    v_caught := SQLERRM;
    if position('body_blocked_doxxing_cc' in v_caught) = 0 then
      raise exception 'C3 FAIL: expected body_blocked_doxxing_cc, got "%"', v_caught;
    end if;
  end;
end $$;

-- C4 — normal body succeeds.
do $$
declare
  v_id text;
begin
  v_id := pg_temp.cx_create('I think the bill is a mixed bag — some fine, some bad.');
  if v_id is null then
    raise exception 'C4 FAIL: expected an inserted row id';
  end if;
end $$;

-- C5 — disabled pattern is ignored.
do $$
declare
  v_pid uuid;
  v_id text;
begin
  insert into public.comment_block_patterns (pattern, reason_label, enabled)
    values ('banana', 'operator_disabled_test', false)
    returning id into v_pid;
  v_id := pg_temp.cx_create('bananas are great and I will say banana again');
  if v_id is null then
    raise exception 'C5 FAIL: disabled pattern unexpectedly blocked';
  end if;
end $$;

-- C6 — operator-added enabled wordlist entry surfaces its reason label.
do $$
declare
  v_caught text;
begin
  insert into public.comment_block_patterns (pattern, reason_label)
    values ('\mforbidden-word\M', 'operator_wordlist');
  begin
    perform pg_temp.cx_create('this line has a forbidden-word in it');
    raise exception 'C6 FAIL: expected 23514, got success';
  exception when check_violation then
    v_caught := SQLERRM;
    if position('body_blocked_operator_wordlist' in v_caught) = 0 then
      raise exception 'C6 FAIL: expected body_blocked_operator_wordlist, got "%"', v_caught;
    end if;
  end;
end $$;

rollback;
\echo 'ALL comment_safety_precheck ASSERTIONS PASSED (C1-C6)'
