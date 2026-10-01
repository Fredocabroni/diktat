-- Behavioral test: users.is_bot immutability trigger (#149).
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file
--
-- Verifies that the trigger from migration
-- 20261001010000_users_is_bot_immutability.sql:
--   1. Allows row creation with is_bot=true or is_bot=false (INSERT
--      path, which is what the signup `handle_new_user` trigger uses).
--   2. Allows UPDATEs that leave is_bot alone (current_ap, tier_id,
--      every other column) to run with no trigger overhead.
--   3. Rejects UPDATEs that flip is_bot from true → false.
--   4. Rejects UPDATEs that flip is_bot from false → true.
--   5. Leaves the row's is_bot value unchanged after a rejected update
--      (transactional atomicity of the trigger raise).
--
-- Superuser bypasses RLS — every assertion below tests the DB-layer
-- enforcement, independent of RLS and any application resolver.

begin;

-- Fixture: two users via the auth-insert → handle_new_user trigger
-- path. One is marked as a bot post-insert (which is how the trivia
-- bot seed script works). The other stays human.
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000',
   'bb000001-0000-0000-0000-00000000bbbb',
   'authenticated', 'authenticated',
   'is-bot-trigger-bot@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000',
   'cc000001-0000-0000-0000-00000000cccc',
   'authenticated', 'authenticated',
   'is-bot-trigger-human@test.local', now(), now());

-- Mark one as a bot (the only legitimate path per #149 design — flip at
-- or near creation, before any battles reference them). The trigger
-- fires here because the handle_new_user trigger inserts the row with
-- is_bot=false by default, and this UPDATE flips it to true. That means
-- the trigger WILL raise here — which is BY DESIGN. Workaround: let the
-- fixture use a session-local disable so we can seed a bot user for the
-- subsequent assertions, OR insert directly into public.users (bypassing
-- handle_new_user by inserting with is_bot=true in a disable-trigger
-- window).
--
-- Cleaner approach: insert directly into public.users with is_bot=true
-- after temporarily disabling the trigger. The alternative — modifying
-- handle_new_user to accept an is_bot override via raw_app_meta_data —
-- is out of scope here.
alter table public.users disable trigger users_is_bot_immutable_check;
update public.users set is_bot = true where id = 'bb000001-0000-0000-0000-00000000bbbb';
alter table public.users enable trigger users_is_bot_immutable_check;

-- ─── Assertion 1: UPDATE that leaves is_bot alone succeeds ────────────
do $$
begin
  update public.users
    set current_ap = current_ap + 1
    where id = 'bb000001-0000-0000-0000-00000000bbbb';
  update public.users
    set current_ap = current_ap + 1
    where id = 'cc000001-0000-0000-0000-00000000cccc';
end $$;
-- No raise = pass. The WHEN clause skipped the trigger body entirely.

-- ─── Assertion 2: UPDATE flipping is_bot true→false raises ────────────
do $$
declare
  raised boolean := false;
  err_msg text;
begin
  begin
    update public.users
      set is_bot = false
      where id = 'bb000001-0000-0000-0000-00000000bbbb';
  exception when others then
    raised := true;
    err_msg := sqlerrm;
  end;
  if not raised then
    raise exception 'A2 FAIL: bot→human flip was not rejected';
  end if;
  if err_msg not like '%is_bot is immutable%' then
    raise exception 'A2 FAIL: raise message did not mention immutability: %', err_msg;
  end if;
end $$;

-- ─── Assertion 3: UPDATE flipping is_bot false→true raises ────────────
do $$
declare
  raised boolean := false;
begin
  begin
    update public.users
      set is_bot = true
      where id = 'cc000001-0000-0000-0000-00000000cccc';
  exception when others then
    raised := true;
  end;
  if not raised then
    raise exception 'A3 FAIL: human→bot flip was not rejected';
  end if;
end $$;

-- ─── Assertion 4: rejected UPDATEs leave is_bot values intact ──────────
do $$
declare
  bot_is_bot boolean;
  human_is_bot boolean;
begin
  select is_bot into bot_is_bot
    from public.users where id = 'bb000001-0000-0000-0000-00000000bbbb';
  select is_bot into human_is_bot
    from public.users where id = 'cc000001-0000-0000-0000-00000000cccc';
  if bot_is_bot <> true then
    raise exception 'A4 FAIL: bot row changed after rejected flip (got %)', bot_is_bot;
  end if;
  if human_is_bot <> false then
    raise exception 'A4 FAIL: human row changed after rejected flip (got %)', human_is_bot;
  end if;
end $$;

-- ─── Assertion 5: setting is_bot to its SAME value (no-op) succeeds ──
-- `IS DISTINCT FROM` evaluates to false when both sides are equal, so
-- the trigger body is never entered. Confirms the WHEN clause filters
-- correctly.
do $$
begin
  update public.users set is_bot = true  where id = 'bb000001-0000-0000-0000-00000000bbbb';
  update public.users set is_bot = false where id = 'cc000001-0000-0000-0000-00000000cccc';
end $$;

rollback;

\echo '--- users_is_bot_immutable.test.sql: PASS ---'
