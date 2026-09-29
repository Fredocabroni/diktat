-- Behavioral test: dead-man's switch state machine (Issue #127 PR B)
-- --------------------------------------------------------------------
--
-- Walks the full outage sequence end-to-end. Both `dead_man_should_fire()`
-- and the `internal.dead_man_state` row after each `dead_man_record(...)`
-- are asserted, so the send-vs-record split from the design is proven:
-- record('fire') MUST write last_action='fire';
-- record('recover') MUST write last_action='quiet'.
--
-- Also verifies the "no vault secrets → tick raises, state unchanged"
-- contract that closes the "silently records fire without alerting"
-- failure mode.
--
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f this-file
--
-- Every assertion uses a DO block with RAISE EXCEPTION on failure so
-- ON_ERROR_STOP aborts the whole file. The final `\echo PASS` fires only
-- when every assertion passed.

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- Setup: reset state to the migration-seeded quiet baseline.
-- ───────────────────────────────────────────────────────────────────────────

update internal.dead_man_state
   set last_action='quiet', last_alert_at=null, last_recover_at=null
 where id=1;

-- Any heartbeat rows left over from other tests would contaminate the
-- newest-done lookup. Wipe them.
delete from public.scheduled_jobs where job_type='heartbeat';

-- Delete any vault secrets from a previous test invocation (fresh CI stack
-- will be empty; local re-runs need the reset).
delete from vault.secrets where name in (
  'dead_man_telegram_bot_token', 'dead_man_telegram_chat_id'
);

-- ───────────────────────────────────────────────────────────────────────────
-- Step 1: HEALTHY.
--   Fresh heartbeat processed just now, state quiet.
--   → should_fire = 'quiet'; state unchanged.
-- ───────────────────────────────────────────────────────────────────────────

insert into public.scheduled_jobs
  (job_type, idempotency_key, status, processed_at)
values
  ('heartbeat', 'test-step-1', 'done', now());

do $$
declare
  d record;
begin
  select * into d from internal.dead_man_should_fire();
  if d.action <> 'quiet' then
    raise exception 'step 1 FAIL: expected action=quiet, got %', d.action;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Step 2: STALE.
--   Rewind the newest heartbeat's processed_at to 25 min ago, state quiet.
--   → should_fire = 'fire'. Call record('fire').
--   → state row: last_action='fire', last_alert_at ~ now.
-- ───────────────────────────────────────────────────────────────────────────

update public.scheduled_jobs
   set processed_at = now() - interval '25 minutes'
 where job_type = 'heartbeat' and idempotency_key = 'test-step-1';

do $$
declare
  d      record;
  s_row  internal.dead_man_state%rowtype;
begin
  select * into d from internal.dead_man_should_fire();
  if d.action <> 'fire' then
    raise exception 'step 2 FAIL: expected action=fire, got %', d.action;
  end if;

  perform internal.dead_man_record('fire');

  select * into s_row from internal.dead_man_state where id=1;
  if s_row.last_action <> 'fire' then
    raise exception 'step 2 FAIL: record(fire) did not set last_action=fire, got %',
      s_row.last_action;
  end if;
  if s_row.last_alert_at is null
     or s_row.last_alert_at < now() - interval '5 seconds' then
    raise exception 'step 2 FAIL: record(fire) did not stamp last_alert_at (got %)',
      s_row.last_alert_at;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Step 3: STILL STALE, ALERTED RECENTLY.
--   No new heartbeat. State: fire, alerted ~seconds ago.
--   → should_fire = 'suppress'. No re-alert.
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  d record;
begin
  select * into d from internal.dead_man_should_fire();
  if d.action <> 'suppress' then
    raise exception 'step 3 FAIL: expected action=suppress, got %', d.action;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Step 4: STILL STALE, ALERT COOLDOWN ELAPSED.
--   Rewind last_alert_at to 90 min ago.
--   → should_fire = 'fire' again. Call record('fire').
--   → last_alert_at reset to now.
-- ───────────────────────────────────────────────────────────────────────────

update internal.dead_man_state
   set last_alert_at = now() - interval '90 minutes'
 where id=1;

do $$
declare
  d       record;
  s_row   internal.dead_man_state%rowtype;
  before  timestamptz;
begin
  select last_alert_at into before from internal.dead_man_state where id=1;

  select * into d from internal.dead_man_should_fire();
  if d.action <> 'fire' then
    raise exception 'step 4 FAIL: expected action=fire (post-cooldown), got %',
      d.action;
  end if;

  perform internal.dead_man_record('fire');

  select * into s_row from internal.dead_man_state where id=1;
  if s_row.last_alert_at <= before then
    raise exception 'step 4 FAIL: record(fire) did not advance last_alert_at (before %, after %)',
      before, s_row.last_alert_at;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Step 5: RECOVERED.
--   Fresh heartbeat done_at=now(). State still fire.
--   → should_fire = 'recover'. Call record('recover').
--   → state row: last_action='quiet', last_recover_at ~ now.
-- ───────────────────────────────────────────────────────────────────────────

insert into public.scheduled_jobs
  (job_type, idempotency_key, status, processed_at)
values
  ('heartbeat', 'test-step-5', 'done', now());

do $$
declare
  d      record;
  s_row  internal.dead_man_state%rowtype;
begin
  select * into d from internal.dead_man_should_fire();
  if d.action <> 'recover' then
    raise exception 'step 5 FAIL: expected action=recover, got %', d.action;
  end if;

  perform internal.dead_man_record('recover');

  select * into s_row from internal.dead_man_state where id=1;
  if s_row.last_action <> 'quiet' then
    raise exception 'step 5 FAIL: record(recover) did not set last_action=quiet, got %',
      s_row.last_action;
  end if;
  if s_row.last_recover_at is null
     or s_row.last_recover_at < now() - interval '5 seconds' then
    raise exception 'step 5 FAIL: record(recover) did not stamp last_recover_at (got %)',
      s_row.last_recover_at;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Step 6: POST-RECOVERY.
--   Same fresh heartbeat, state now quiet.
--   → should_fire = 'quiet'. No second recovery message.
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  d record;
begin
  select * into d from internal.dead_man_should_fire();
  if d.action <> 'quiet' then
    raise exception 'step 6 FAIL: expected action=quiet (post-recovery), got %',
      d.action;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Step 7: record() rejects unknown actions.
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  ok boolean := false;
begin
  begin
    perform internal.dead_man_record('bogus');
  exception when others then
    ok := true;
  end;
  if not ok then
    raise exception 'step 7 FAIL: record(bogus) did not raise';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Step 8: NO VAULT SECRETS → tick RAISES → state unchanged.
--
-- Force a stale-fire condition (rewind step-5's heartbeat + reset state
-- to quiet), then call the tick with vault empty. dead_man_send() must
-- raise inside dead_man_tick(), which must propagate — leaving the state
-- row unchanged. The failure mode this test closes is a silent recording
-- of 'fire' when no message could be sent.
-- ───────────────────────────────────────────────────────────────────────────

update public.scheduled_jobs
   set processed_at = now() - interval '25 minutes'
 where job_type='heartbeat' and idempotency_key='test-step-5';

update internal.dead_man_state
   set last_action='quiet', last_alert_at=null, last_recover_at=null
 where id=1;

do $$
declare
  s_before  internal.dead_man_state%rowtype;
  s_after   internal.dead_man_state%rowtype;
  raised    boolean := false;
  err_msg   text;
begin
  select * into s_before from internal.dead_man_state where id=1;

  begin
    perform internal.dead_man_tick();
  exception when others then
    raised := true;
    err_msg := sqlerrm;
  end;

  if not raised then
    raise exception 'step 8 FAIL: dead_man_tick() did not raise with no vault secrets';
  end if;

  -- Error message must name the missing secret (helps operators).
  if err_msg not like '%dead_man_telegram_bot_token%' then
    raise exception 'step 8 FAIL: raise message did not name the missing secret: %', err_msg;
  end if;

  select * into s_after from internal.dead_man_state where id=1;
  if s_after.last_action  is distinct from s_before.last_action
     or s_after.last_alert_at is distinct from s_before.last_alert_at
     or s_after.last_recover_at is distinct from s_before.last_recover_at then
    raise exception 'step 8 FAIL: state row changed after tick raise (before %, after %)',
      s_before, s_after;
  end if;
end $$;

-- Rollback: leave the DB clean for the next test. All fixtures were
-- inserted inside this transaction; ROLLBACK below drops them.
rollback;

\echo '--- dead_man_switch.test.sql: PASS ---'
