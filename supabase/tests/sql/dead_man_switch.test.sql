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

-- ───────────────────────────────────────────────────────────────────────────
-- Step 9: BAD TOKEN SHAPE → tick RAISES → state unchanged (#147 M1).
--
-- Vault has a bot token that does NOT match the `<botid>:<hash>` shape
-- (missing colon). Tick must raise inside dead_man_send and the state
-- row must stay unchanged — same silent-advance failure mode as step 8,
-- extended to catch a mis-pasted secret that was previously accepted.
-- ───────────────────────────────────────────────────────────────────────────

select vault.create_secret('garbage-no-colon-token',          'dead_man_telegram_bot_token');
select vault.create_secret('123456',                           'dead_man_telegram_chat_id');

update public.scheduled_jobs
   set processed_at = now() - interval '25 minutes'
 where job_type='heartbeat' and idempotency_key='test-step-5';

update internal.dead_man_state
   set last_action='quiet',
       last_alert_at=null,
       last_recover_at=null,
       last_send_request_id=null,
       pending_action=null
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
    raise exception 'step 9 FAIL: dead_man_tick() did not raise on malformed token';
  end if;

  if err_msg not like '%invalid shape%' then
    raise exception 'step 9 FAIL: raise message did not name shape error: %', err_msg;
  end if;

  select * into s_after from internal.dead_man_state where id=1;
  if s_after is distinct from s_before then
    raise exception 'step 9 FAIL: state row changed after malformed-token tick (before %, after %)',
      s_before, s_after;
  end if;
end $$;

-- Reset vault to a well-formed token for the remaining send-path tests.
delete from vault.secrets where name in (
  'dead_man_telegram_bot_token', 'dead_man_telegram_chat_id'
);
select vault.create_secret('123456789:ABCdefGHIjklMNOpqrsTUVwxyz-_0123456789', 'dead_man_telegram_bot_token');
select vault.create_secret('987654321',                                        'dead_man_telegram_chat_id');

-- ───────────────────────────────────────────────────────────────────────────
-- Step 10: SEND STASHES PENDING + REQUEST_ID (#147 M2 part A).
--
-- With a valid-shape token, a stale-fire tick must POST and leave the
-- state row with pending_action='fire' and a non-null last_send_request_id
-- so the NEXT tick can confirm delivery.
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  s_row  internal.dead_man_state%rowtype;
begin
  perform internal.dead_man_tick();

  select * into s_row from internal.dead_man_state where id=1;

  if s_row.pending_action is distinct from 'fire' then
    raise exception 'step 10 FAIL: tick did not stash pending_action=fire (got %)',
      s_row.pending_action;
  end if;
  if s_row.last_send_request_id is null then
    raise exception 'step 10 FAIL: tick did not stash last_send_request_id';
  end if;
  -- CRITICAL: last_action must NOT be 'fire' yet — the record() call is
  -- deferred until the next tick confirms delivery. If this assertion
  -- fails, the inline record() of pre-hardening behavior has leaked back.
  if s_row.last_action = 'fire' then
    raise exception 'step 10 FAIL: tick recorded fire inline before delivery confirmation';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Step 11: NEXT-TICK CONFIRM (200) RECORDS FIRE (#147 M2 part B).
--
-- Simulate pg_net landing a successful response: insert a 200 row into
-- net._http_response keyed on last_send_request_id, then run the tick.
-- The tick must record('fire') and clear the pending slot.
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  v_req     bigint;
  s_row     internal.dead_man_state%rowtype;
begin
  select last_send_request_id into v_req from internal.dead_man_state where id=1;

  -- Simulate pg_net completing with HTTP 200. net._http_response is
  -- populated by the extension in prod; in tests we insert directly so
  -- the state machine sees "delivery confirmed." Only the columns
  -- dead_man_tick reads (status_code, error_msg, timed_out) are set;
  -- the rest take their defaults (pg_net schema varies across versions,
  -- so narrower is safer).
  insert into net._http_response (id, status_code, timed_out, error_msg)
  values (v_req, 200, false, null);

  perform internal.dead_man_tick();

  select * into s_row from internal.dead_man_state where id=1;

  if s_row.last_action is distinct from 'fire' then
    raise exception 'step 11 FAIL: confirmed-200 tick did not record fire (got last_action=%)',
      s_row.last_action;
  end if;
  if s_row.pending_action is not null then
    raise exception 'step 11 FAIL: confirmed-200 tick did not clear pending_action (got %)',
      s_row.pending_action;
  end if;
  if s_row.last_send_request_id is not null then
    raise exception 'step 11 FAIL: confirmed-200 tick did not clear last_send_request_id (got %)',
      s_row.last_send_request_id;
  end if;
  if s_row.last_alert_at is null then
    raise exception 'step 11 FAIL: record(fire) did not stamp last_alert_at';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Step 12: NEXT-TICK CONFIRM (non-200) CLEARS WITHOUT RECORDING (#147 M2
-- part C).
--
-- Rewind cooldown + heartbeat so a fresh send fires, then simulate
-- pg_net landing a 400 response. The confirming tick must emit a NOTICE
-- and clear the pending slot WITHOUT calling record() — so the next
-- cycle can re-synthesise and try again rather than treating the failed
-- POST as "already alerted."
-- ───────────────────────────────────────────────────────────────────────────

update internal.dead_man_state
   set last_alert_at = now() - interval '90 minutes'
 where id=1;

do $$
declare
  s_before    internal.dead_man_state%rowtype;
  s_mid       internal.dead_man_state%rowtype;
  s_after     internal.dead_man_state%rowtype;
  v_req       bigint;
begin
  select * into s_before from internal.dead_man_state where id=1;

  -- Fire a fresh send (should_fire=fire again after cooldown rewind).
  perform internal.dead_man_tick();

  select * into s_mid from internal.dead_man_state where id=1;
  if s_mid.last_send_request_id is null or s_mid.pending_action is distinct from 'fire' then
    raise exception 'step 12 FAIL: did not stash pending send for failed-delivery branch (state=%)',
      s_mid;
  end if;
  v_req := s_mid.last_send_request_id;

  -- Simulate pg_net landing a 400. Same minimal-insert shape as step 11.
  insert into net._http_response (id, status_code, timed_out, error_msg)
  values (v_req, 400, false, 'Bad Request');

  -- Confirming tick: must NOT record and must clear pending.
  perform internal.dead_man_tick();

  select * into s_after from internal.dead_man_state where id=1;
  if s_after.pending_action is not null then
    raise exception 'step 12 FAIL: failed-delivery tick did not clear pending_action (got %)',
      s_after.pending_action;
  end if;
  if s_after.last_send_request_id is not null then
    raise exception 'step 12 FAIL: failed-delivery tick did not clear last_send_request_id (got %)',
      s_after.last_send_request_id;
  end if;
  -- Did NOT re-record: last_alert_at must not have advanced beyond the
  -- send stamp (s_mid.last_alert_at).
  if s_after.last_alert_at is distinct from s_mid.last_alert_at then
    raise exception 'step 12 FAIL: failed-delivery tick advanced last_alert_at (mid %, after %) — record() was called in error',
      s_mid.last_alert_at, s_after.last_alert_at;
  end if;
end $$;

-- Rollback: leave the DB clean for the next test. All fixtures (vault
-- secrets, heartbeat jobs, _http_response rows) were inserted inside
-- this transaction; ROLLBACK below drops them.
rollback;

\echo '--- dead_man_switch.test.sql: PASS ---'
