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
  -- Round-1 HIGH-1: pending_since is stamped at send time (not next-tick
  -- confirmation). Must be set alongside the request_id.
  if s_row.pending_since is null then
    raise exception 'step 10 FAIL: tick did not stash pending_since';
  end if;
  if s_row.pending_since < now() - interval '5 seconds' then
    raise exception 'step 10 FAIL: pending_since looks stale (got %)',
      s_row.pending_since;
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
  if s_row.pending_since is not null then
    raise exception 'step 11 FAIL: confirmed-200 tick did not clear pending_since (got %)',
      s_row.pending_since;
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

  -- Confirming tick: must NOT record, must clear pending, AND will
  -- re-synthesise a new send on the SAME tick because the decision
  -- phase runs after confirm and should_fire still returns 'fire'
  -- (same stale heartbeat, same old last_alert_at — the failed
  -- delivery was NOT a successful alert).
  perform internal.dead_man_tick();

  select * into s_after from internal.dead_man_state where id=1;

  -- (1) Did NOT re-record. last_alert_at must be unchanged from
  --     s_mid.last_alert_at. If it advanced, record() ran — which is
  --     the exact failure mode M2 is designed to prevent (silently
  --     advancing the 1-hour dedup clock on a POST that never
  --     delivered).
  if s_after.last_alert_at is distinct from s_mid.last_alert_at then
    raise exception 'step 12 FAIL: failed-delivery tick advanced last_alert_at (mid %, after %) — record() was called in error',
      s_mid.last_alert_at, s_after.last_alert_at;
  end if;

  -- (2) The confirm phase cleared v_req before the decision phase
  --     re-stamped a new one. Prove it by asserting last_send_request_id
  --     is set but DIFFERENT from v_req. If the confirm phase hadn't
  --     cleared the slot, the decision phase's "already in flight"
  --     early return would have kicked in and v_req would still be
  --     there — so a non-v_req request_id is proof of both clear and
  --     re-synthesise.
  if s_after.last_send_request_id is null then
    raise exception 'step 12 FAIL: failed-delivery tick did not re-synthesise a new send';
  end if;
  if s_after.last_send_request_id = v_req then
    raise exception 'step 12 FAIL: failed-delivery tick did not clear v_req before re-synthesising (got same request_id %)',
      v_req;
  end if;
  if s_after.pending_action is distinct from 'fire' then
    raise exception 'step 12 FAIL: expected pending_action=fire after re-synthesis, got %',
      s_after.pending_action;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Step 13: FORCE-CLEAR after >10 min of no response row — HIGH-1 regression
-- guard.
--
-- The pre-fix 10-min force-clear keyed on `last_alert_at`, which is only
-- stamped by NEXT-tick confirmation. On a first-ever fire cycle
-- (`last_alert_at IS NULL`) the guard short-circuited and the pending
-- slot was wedged forever. The fix keys on `pending_since` (set inside
-- dead_man_send alongside the request_id).
--
-- Setup: reset state to a "first-ever fire" shape (last_alert_at=null),
-- stash a pending slot with pending_since 11 min ago, run the tick
-- without a corresponding net._http_response row.
--
-- Expect: force-clear fires. The slot (last_send_request_id, pending_action,
-- pending_since) is wiped. last_alert_at stays NULL — this guard is
-- about surviving the first-cycle case specifically.
-- ───────────────────────────────────────────────────────────────────────────

update internal.dead_man_state
   set last_action='quiet',
       last_alert_at=null,
       last_recover_at=null,
       last_send_request_id=99999999,
       pending_action='fire',
       pending_since=now() - interval '11 minutes'
 where id=1;

do $$
declare
  s_after  internal.dead_man_state%rowtype;
begin
  -- No net._http_response row exists for request_id=99999999, and
  -- pending_since is 11 min ago — force-clear path.
  perform internal.dead_man_tick();

  select * into s_after from internal.dead_man_state where id=1;

  if s_after.last_send_request_id is not null then
    raise exception 'step 13 FAIL: wedged-pending force-clear did not wipe last_send_request_id (got %)',
      s_after.last_send_request_id;
  end if;
  if s_after.pending_action is not null then
    raise exception 'step 13 FAIL: wedged-pending force-clear did not wipe pending_action (got %)',
      s_after.pending_action;
  end if;
  -- pending_since should be either null (force-clear wiped it) OR set
  -- fresh by the SAME tick's decision phase (if should_fire re-fired).
  -- Both are correct — the hard contract is just "the wedged 11-min-ago
  -- value is gone".
  if s_after.pending_since is not null
     and s_after.pending_since < now() - interval '5 seconds' then
    raise exception 'step 13 FAIL: wedged-pending force-clear left stale pending_since (got %)',
      s_after.pending_since;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Step 14: NULL pending_action on confirmed 200 — tick does NOT raise, does
-- NOT advance last_action, DOES clear the slot cleanly (round-3 HIGH-2).
--
-- Setup: manually set a pending_slot WITHOUT pending_action (as a backfill
-- artifact or operator debug would). Insert a 200 response. Run the tick.
--
-- Pre-fix behaviour: dead_man_record(NULL) raised, tick aborted, slot
-- stayed wedged until the 10-min force-clear caught it. Post-fix: the
-- 200-branch guards on pending_action IS NOT NULL and emits a NOTICE.
-- ───────────────────────────────────────────────────────────────────────────

update internal.dead_man_state
   set last_action='quiet',
       last_alert_at=null,
       last_recover_at=null,
       last_send_request_id=77777777,
       pending_action=null,
       pending_since=now() - interval '2 minutes'
 where id=1;

insert into net._http_response (id, status_code, timed_out, error_msg)
values (77777777, 200, false, null);

do $$
declare
  s_before  internal.dead_man_state%rowtype;
  s_after   internal.dead_man_state%rowtype;
begin
  select * into s_before from internal.dead_man_state where id=1;

  -- The pre-fix path would raise 'invalid action: null' here (because
  -- the 200-confirm branch called dead_man_record(NULL)).
  perform internal.dead_man_tick();

  select * into s_after from internal.dead_man_state where id=1;

  -- (1) The wedged request_id (77777777) was cleared. The decision
  --     phase re-synthesises a fresh send on the same tick because the
  --     heartbeat is still 25-min stale and last_action stayed 'quiet'
  --     (record was NOT called), so a non-null last_send_request_id
  --     that is DIFFERENT from 77777777 is the right observable —
  --     identical shape to step 12.
  if s_after.last_send_request_id = 77777777 then
    raise exception 'step 14 FAIL: NULL-pending confirm did not clear wedged request_id (still 77777777)';
  end if;

  -- (2) record() was NOT called: last_action stayed 'quiet' and
  --     last_alert_at stayed null. This is the load-bearing assertion
  --     — the pre-fix bug was that dead_man_record(NULL) threw and
  --     aborted the tick; post-fix the branch skips record() while
  --     still clearing the slot.
  if s_after.last_action is distinct from s_before.last_action then
    raise exception 'step 14 FAIL: NULL-pending confirm advanced last_action (before %, after %) — record() ran in error',
      s_before.last_action, s_after.last_action;
  end if;
  if s_after.last_alert_at is distinct from s_before.last_alert_at then
    raise exception 'step 14 FAIL: NULL-pending confirm advanced last_alert_at (before %, after %) — record() ran in error',
      s_before.last_alert_at, s_after.last_alert_at;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Step 15: FOR UPDATE on internal.dead_man_state is present in
-- dead_man_tick (round-3 HIGH-1 regression guard).
--
-- Structural assertion against pg_proc.prosrc. Testing concurrent-tick
-- serialisation behaviourally would require two psql sessions; this
-- script is single-session. The function body is small and the FOR
-- UPDATE clause is load-bearing — if a future edit drops it (either
-- by accident or by rewrite), this assertion fires immediately.
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  v_src text;
begin
  select prosrc into v_src
    from pg_proc
    where pronamespace = 'internal'::regnamespace
      and proname = 'dead_man_tick';
  if v_src is null then
    raise exception 'step 15 FAIL: internal.dead_man_tick() not found';
  end if;
  -- Case-insensitive match for `for update` anywhere in the body. The
  -- lock is only called from this function body today, so a lone
  -- `for update` string there is unambiguous.
  if v_src !~* '\bfor\s+update\b' then
    raise exception 'step 15 FAIL: dead_man_tick body does not contain FOR UPDATE (round-3 HIGH-1 regression)';
  end if;
end $$;

-- Rollback: leave the DB clean for the next test. All fixtures (vault
-- secrets, heartbeat jobs, _http_response rows) were inserted inside
-- this transaction; ROLLBACK below drops them.
rollback;

\echo '--- dead_man_switch.test.sql: PASS ---'
