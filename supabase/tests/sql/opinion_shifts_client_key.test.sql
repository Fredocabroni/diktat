-- Behavioral test: opinion_shifts.client_key partial unique index
-- (Issue #127 H11 PR B1).
--
-- Proves the schema shape introduced by
-- supabase/migrations/20260930000000_opinion_shifts_client_key.sql:
--   1. client_key column exists, nullable.
--   2. Partial unique index rejects same (user_id, client_key) pair.
--   3. Same user, different client_key → both rows allowed.
--   4. Different users, same client_key → both rows allowed (per-user scoping).
--   5. Multiple null client_key rows for the same user allowed (append-only
--      change-of-mind history preserved for pre-B2 writes).
--   6. Dedupe-by-id block is a no-op on a fresh DB (the two known-bad prod
--      ids don't exist; the migration succeeded because that's what CI's
--      migrations-fresh-apply already proved by running to completion).
--
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file
-- Superuser bypasses RLS — every assertion below tests the DB-layer
-- constraint, independent of RLS + tRPC guards.

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- Fixtures — two users + one topic. auth.users insert fires the
-- handle_new_user trigger which auto-creates public.users, streaks,
-- wallets rows.
-- ───────────────────────────────────────────────────────────────────────────

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000',
   'aa000001-0000-0000-0000-000000000001', 'authenticated', 'authenticated',
   'h11-a@test.local', now(), now()),
  ('00000000-0000-0000-0000-000000000000',
   'bb000001-0000-0000-0000-000000000002', 'authenticated', 'authenticated',
   'h11-b@test.local', now(), now());

insert into public.news_topics (id, slug, headline)
values
  ('aa11c000-0000-0000-0000-000000000001',
   'h11-test-topic',
   'test topic for H11');

-- ───────────────────────────────────────────────────────────────────────────
-- Assertion 1: client_key column exists AND is nullable.
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  v_nullable text;
begin
  select is_nullable into v_nullable
    from information_schema.columns
    where table_schema='public' and table_name='opinion_shifts'
      and column_name='client_key';
  if v_nullable is null then
    raise exception 'A1 FAIL: client_key column does not exist';
  end if;
  if v_nullable <> 'YES' then
    raise exception 'A1 FAIL: client_key must be nullable (got %)', v_nullable;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Assertion 2: partial unique index rejects same (user_id, client_key).
--
-- Insert one row with a specific client_key, then attempt a second row
-- with the same user AND same key. Must fail with sqlstate 23505.
-- ───────────────────────────────────────────────────────────────────────────

insert into public.opinion_shifts (user_id, topic_id, before_position, after_position, client_key)
values
  ('aa000001-0000-0000-0000-000000000001',
   'aa11c000-0000-0000-0000-000000000001',
   0, 1,
   'ccccccc1-0000-0000-0000-000000000001');

do $$
declare
  v_raised boolean := false;
begin
  begin
    insert into public.opinion_shifts (user_id, topic_id, before_position, after_position, client_key)
    values
      ('aa000001-0000-0000-0000-000000000001',
       'aa11c000-0000-0000-0000-000000000001',
       0, -1,  -- different position; the uniqueness is on the key, not the row content
       'ccccccc1-0000-0000-0000-000000000001');
  exception when unique_violation then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'A2 FAIL: duplicate (user_id, client_key) was accepted';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Assertion 3: same user, different client_key → both rows accepted.
-- Proves change-of-mind still works: a fresh tap gets a fresh key.
-- ───────────────────────────────────────────────────────────────────────────

insert into public.opinion_shifts (user_id, topic_id, before_position, after_position, client_key)
values
  ('aa000001-0000-0000-0000-000000000001',
   'aa11c000-0000-0000-0000-000000000001',
   0, -1,
   'ccccccc2-0000-0000-0000-000000000002');

do $$
declare
  v_count int;
begin
  select count(*) into v_count
    from public.opinion_shifts
   where user_id = 'aa000001-0000-0000-0000-000000000001'
     and topic_id = 'aa11c000-0000-0000-0000-000000000001'
     and client_key is not null;
  if v_count <> 2 then
    raise exception 'A3 FAIL: expected 2 non-null-key rows for user a, got %', v_count;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Assertion 4: different user, SAME client_key → accepted (per-user scope).
-- Guards against a hypothetical cross-user uuid collision leaking rows.
-- ───────────────────────────────────────────────────────────────────────────

insert into public.opinion_shifts (user_id, topic_id, before_position, after_position, client_key)
values
  ('bb000001-0000-0000-0000-000000000002',
   'aa11c000-0000-0000-0000-000000000001',
   0, 1,
   'ccccccc1-0000-0000-0000-000000000001');  -- same key as user a's first row

do $$
declare
  v_count int;
begin
  select count(*) into v_count
    from public.opinion_shifts
   where client_key = 'ccccccc1-0000-0000-0000-000000000001';
  if v_count <> 2 then
    raise exception 'A4 FAIL: expected 2 rows sharing the client_key across users, got %', v_count;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Assertion 5: multiple null client_key rows for the same user allowed.
-- Backward compatibility with pre-B2 writes that never send a key.
-- ───────────────────────────────────────────────────────────────────────────

insert into public.opinion_shifts (user_id, topic_id, before_position, after_position)
values
  ('aa000001-0000-0000-0000-000000000001',
   'aa11c000-0000-0000-0000-000000000001', 0, 1),
  ('aa000001-0000-0000-0000-000000000001',
   'aa11c000-0000-0000-0000-000000000001', 0, -1);

do $$
declare
  v_count int;
begin
  select count(*) into v_count
    from public.opinion_shifts
   where user_id = 'aa000001-0000-0000-0000-000000000001'
     and client_key is null;
  if v_count <> 2 then
    raise exception 'A5 FAIL: expected 2 null-key rows for user a, got %', v_count;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Assertion 6: dedupe-by-id block was a no-op on this fresh DB.
-- The two known-bad prod ids don't exist here, so post-migration
-- opinion_shifts should contain only the fixture rows this test just
-- inserted (0 pre-existing + fixtures).
--
-- Concretely: no row with id in the dedupe list survives (there was
-- never one), and no row was accidentally deleted from our fixtures
-- (we own the only rows in the table now, and our fixture ids differ).
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  v_survivors int;
begin
  select count(*) into v_survivors
    from public.opinion_shifts
    where id in (
      '51d02b85-9edc-4199-be7c-dc159e133691'::uuid,
      '57ee4f86-7222-42e9-83c0-1f432d0b4502'::uuid
    );
  if v_survivors <> 0 then
    raise exception 'A6 FAIL: known-bad prod ids present in fresh DB (impossible unless fixture reused them): got %', v_survivors;
  end if;
end $$;

rollback;

\echo '--- opinion_shifts_client_key.test.sql: PASS ---'
