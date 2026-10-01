-- Migration: harden internal.dead_man_send + add next-tick delivery check (#147).
-- Up:   extend internal.dead_man_state with `last_send_request_id`,
--       `pending_action`, and `pending_since`; redefine internal.dead_man_send
--       to validate the Telegram token shape and stash the pending action +
--       request_id + send timestamp before http_post; redefine
--       internal.dead_man_tick to confirm the previous send's delivery
--       via net._http_response BEFORE issuing a new one and to force-clear
--       a wedged pending slot after 10 minutes keyed on pending_since
--       (not last_alert_at).
-- Down: see `-- Rollback (reference, not auto-run):` block below —
--       drop the new columns + CREATE OR REPLACE the functions back
--       to their 20260929230000 shape; revoke INSERT grant stays safe
--       since pg_net ships without PUBLIC inserts.
--
-- Round-3 security-reviewer findings addressed (operator-ask, 2026-10-01):
--
--   (R3 HIGH-1) Concurrent dead_man_tick calls could both pass should_fire
--   and both call dead_man_send — the "double-fire" race on rare pg_cron
--   double-fires / operator-manual ticks. Fix: SELECT ... FOR UPDATE on
--   internal.dead_man_state (single row, id=1) at the top of
--   dead_man_tick. Serialises concurrent ticks for the duration of the
--   function body; released on COMMIT.
--
--   (R3 HIGH-2) If an operator or a future backfill set
--   last_send_request_id without also setting pending_action, the 200-
--   confirm branch's dead_man_record(NULL) raised, the tick aborted,
--   and the slot sat wedged until the 10-min force-clear caught it.
--   Fix: guard the record() call on pending_action IS NOT NULL;
--   when NULL, emit a NOTICE and still clear the slot cleanly.
--
-- Round-1 security-reviewer findings addressed:
--
--   (HIGH-1) Original timeout guard keyed on `last_alert_at`, which is
--   only stamped on NEXT-tick confirmation of a successful delivery. On
--   the very first fire cycle `last_alert_at IS NULL`, so the guard
--   short-circuits and `last_send_request_id` sits forever if pg_net
--   never produces a response row. New column `pending_since`
--   timestamptz is set inside dead_man_send alongside the request_id
--   and cleared alongside pending_action; the 10-min force-clear is
--   now keyed on `pending_since`.
--
--   (HIGH-2) Semantic gap between `last_action` (`'quiet'|'fire'`) and
--   `pending_action` (`'fire'|'recover'`) was undocumented. Column
--   comments below explicitly spell out that `pending_action='recover'`
--   resolves to `last_action='quiet'` on confirmation.
--
--   (MED-1) `error_msg` from net._http_response is logged into
--   NOTICE output. On a Telegram 401 the response body can echo back
--   the token prefix. The failed-delivery RAISE NOTICE now sanitises
--   `error_msg` through a regex redaction before logging — same shape
--   as `scrubMessage` on the application side.
--
--   (MED-2) Original revision of this migration added REVOKEs on
--   net._http_response + net.http_request_queue. Pulled from this PR
--   on operator ask (2026-10-01) — grants on Supabase-managed extension
--   tables are reset by extension upgrades, and the mitigation strength
--   doesn't justify the ongoing maintenance risk of silently
--   disappearing on a `supabase extensions update`. Spoof vector is
--   theoretical (requires an attacker who already knows a live
--   last_send_request_id bigint AND holds INSERT on net._http_response,
--   which pg_net does not grant to authenticated/anon by default on
--   current versions). Filed as #163 so the grants are audited against
--   the live prod posture before any REVOKE lands via its own
--   dedicated migration.
--
-- Rollback (reference, not auto-run):
--   create or replace function internal.dead_man_send(p_message text)
--     returns bigint ... (restore 20260929230000's body);
--   create or replace function internal.dead_man_tick() ...
--   alter table internal.dead_man_state
--     drop column if exists last_send_request_id,
--     drop column if exists pending_action,
--     drop column if exists pending_since;

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. State schema extension
-- ───────────────────────────────────────────────────────────────────────────

alter table internal.dead_man_state
  add column if not exists last_send_request_id bigint,
  add column if not exists pending_action text
    check (pending_action is null or pending_action in ('fire', 'recover')),
  add column if not exists pending_since timestamptz;

comment on column internal.dead_man_state.last_send_request_id is
  'pg_net.http_post request id from the most recent dead_man_send call. '
  'Cleared by the next tick after delivery is confirmed via '
  'net._http_response, or force-cleared after pending_since > 10 min.';
comment on column internal.dead_man_state.pending_action is
  'Which record() call to run after the next tick confirms the most '
  'recent send delivered. Values: ''fire'' or ''recover''. Note the '
  'semantic gap with last_action: pending_action=''recover'' resolves '
  'to last_action=''quiet'' on confirmation (dead_man_record writes '
  'last_action=''quiet'' for the recover case). There is NO '
  'last_action=''recover'' value.';
comment on column internal.dead_man_state.pending_since is
  'Timestamp when dead_man_send stashed the current pending slot. Set '
  'inside dead_man_send; cleared alongside pending_action and '
  'last_send_request_id. The dead_man_tick force-clear guard reads '
  'this (NOT last_alert_at, which is only stamped on NEXT-tick '
  'confirmation of a prior send and is therefore NULL on the first '
  'fire cycle).';

-- (Round-1 MED-2 REVOKE on net._http_response / net.http_request_queue
-- removed on 2026-10-01 operator ask. See header for rationale and the
-- follow-up issue in the PR body.)

-- ───────────────────────────────────────────────────────────────────────────
-- 2. dead_man_send: validate token shape, stash pending state + since, POST.
--
-- Shape change from 20260929230000: now takes `p_action` so the tick
-- knows what to record on delivery confirmation. Callers inside this
-- migration pass 'fire' or 'recover'.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function internal.dead_man_send(p_message text, p_action text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_token    text;
  v_chat_id  text;
  v_request  bigint;
begin
  if p_action is null or p_action not in ('fire', 'recover') then
    raise exception 'dead_man_send: p_action must be ''fire'' or ''recover'' (got %)', p_action;
  end if;

  select decrypted_secret into v_token
    from vault.decrypted_secrets
   where name = 'dead_man_telegram_bot_token';

  select decrypted_secret into v_chat_id
    from vault.decrypted_secrets
   where name = 'dead_man_telegram_chat_id';

  if v_token is null or length(v_token) = 0 then
    raise exception 'dead_man_send: vault secret dead_man_telegram_bot_token is missing or empty';
  end if;
  if v_chat_id is null or length(v_chat_id) = 0 then
    raise exception 'dead_man_send: vault secret dead_man_telegram_chat_id is missing or empty';
  end if;

  -- #147 M1: validate Telegram token shape BEFORE POSTing. The
  -- `<botid>:<hash>` pattern — numeric id, colon, URL-safe hash.
  if v_token !~ '^[0-9]+:[A-Za-z0-9_-]+$' then
    raise exception
      'dead_man_send: token has invalid shape (expected <botid>:<hash>, got length=%)',
      length(v_token);
  end if;

  select net.http_post(
    url     := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
    body    := jsonb_build_object(
                 'chat_id', v_chat_id,
                 'text',    p_message,
                 'disable_web_page_preview', true
               ),
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 5000
  ) into v_request;

  -- Stash the full pending-slot triple: request_id (for the confirm
  -- lookup), pending_action (for the record() call on 200), and
  -- pending_since (for the force-clear timeout). pending_since replaces
  -- the HIGH-1 broken reliance on last_alert_at.
  update internal.dead_man_state
    set last_send_request_id = v_request,
        pending_action       = p_action,
        pending_since        = now()
    where id = 1;

  return v_request;
end;
$fn$;

revoke execute on function internal.dead_man_send(text, text) from public;
grant  execute on function internal.dead_man_send(text, text) to service_role;

drop function if exists internal.dead_man_send(text);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. dead_man_tick: confirm previous delivery FIRST, then decide fresh.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function internal.dead_man_tick()
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_state      internal.dead_man_state%rowtype;
  v_response   record;
  v_decision   record;
  v_message    text;
  v_err_msg    text;
begin
  -- Round-3 HIGH-1 (operator-ask fix): take a row lock on the state
  -- row for the full tick. pg_cron can double-fire a job in rare
  -- cases (clock skew on the primary, LISTEN/NOTIFY delivery
  -- race, operator-triggered manual tick), and without the lock
  -- two concurrent tick() calls both see pending_action=null,
  -- both pass should_fire(), and both call dead_man_send — the
  -- "double-fire" the reviewer flagged. FOR UPDATE serialises the
  -- ticks: the second tick blocks on the SELECT until the first
  -- tick commits (either having stashed a pending slot or recorded
  -- a terminal action), at which point the second tick re-reads
  -- fresh state and no-ops at should_fire().
  --
  -- The lock is held for the whole function body, released on COMMIT.
  -- Trade-off: a tick holding this lock while waiting for pg_net
  -- (http_post is non-blocking, so the actual wall-clock cost of the
  -- held lock is milliseconds) will delay a concurrent tick by the
  -- same amount. At the pg_cron 5-min cadence this is unobservable.
  select * into v_state from internal.dead_man_state where id = 1 for update;

  -- Step 1: confirm the previous send's delivery, if one is pending.
  if v_state.last_send_request_id is not null then
    select status_code, error_msg, timed_out
      into v_response
      from net._http_response
      where id = v_state.last_send_request_id;

    if not found then
      -- pg_net hasn't landed a response yet. Normal POST latency is
      -- ~1s; 10 min of no row means the request is wedged. The HIGH-1
      -- fix keys the force-clear on `pending_since` (stamped at send
      -- time) instead of `last_alert_at` (only stamped on next-tick
      -- confirmation, so NULL on the first-ever fire cycle). If
      -- pending_since is NULL (impossible — set in lockstep with
      -- request_id — but defensive) treat as "just stashed" and wait.
      if v_state.pending_since is not null
         and v_state.pending_since < now() - interval '10 minutes' then
        raise notice 'dead_man_tick: send request_id=% has no net._http_response row after >10min (pending_since=%); clearing to resynthesise',
          v_state.last_send_request_id, v_state.pending_since;
        update internal.dead_man_state
          set last_send_request_id = null,
              pending_action       = null,
              pending_since        = null
          where id = 1;
      end if;
      return;
    end if;

    if v_response.status_code = 200
       and v_response.error_msg is null
       and coalesce(v_response.timed_out, false) = false then
      -- Delivered. Record the pending action, clear the pending slot.
      --
      -- Round-3 HIGH-2 (operator-ask fix): guard against pending_action
      -- being NULL. In the normal flow dead_man_send stamps
      -- pending_action in the same UPDATE that stamps
      -- last_send_request_id, so this case is unreachable from
      -- supported entry paths. The branch exists for two edge cases:
      -- (a) a manual INSERT / UPDATE on internal.dead_man_state that
      -- set last_send_request_id without pending_action (operator
      -- debugging); (b) a future migration that nulls one column
      -- without the other during a backfill. Without the guard,
      -- dead_man_record(NULL) raises inside this transaction, the
      -- tick aborts, and the slot sits wedged until the 10-min
      -- force-clear catches it. With the guard, the tick clears the
      -- slot cleanly and emits a NOTICE so the operator sees why.
      if v_state.pending_action is null then
        raise notice 'dead_man_tick: confirmed 200 for request_id=% but pending_action is NULL (manual-insert / backfill artifact?); clearing slot without recording',
          v_state.last_send_request_id;
      else
        perform internal.dead_man_record(v_state.pending_action);
      end if;
      update internal.dead_man_state
        set last_send_request_id = null,
            pending_action       = null,
            pending_since        = null
        where id = 1;
    else
      -- Delivery failed. Emit a NOTICE visible in prod logs; clear
      -- the pending slot so the next cycle re-synthesises.
      --
      -- MED-1: redact Telegram-token-shaped substrings from error_msg
      -- before logging. On a 401 the body can echo back the token
      -- prefix (`123456789:ABC...`). Same regex as the application-
      -- side scrubMessage. Also capped at 200 chars.
      v_err_msg := left(
        regexp_replace(coalesce(v_response.error_msg, ''), '[0-9]{5,}:[A-Za-z0-9_-]+', '[REDACTED]', 'g'),
        200
      );
      raise notice 'dead_man_tick: send request_id=% delivery failed (status=%, error_msg=%, timed_out=%)',
        v_state.last_send_request_id,
        v_response.status_code,
        v_err_msg,
        v_response.timed_out;
      update internal.dead_man_state
        set last_send_request_id = null,
            pending_action       = null,
            pending_since        = null
        where id = 1;
    end if;

    -- Re-read state since the branches above modified it.
    select * into v_state from internal.dead_man_state where id = 1;
  end if;

  -- Step 2: fresh decision. Skip if a new send is already in flight
  -- (should be impossible after Step 1 above clears it, but defensive).
  if v_state.last_send_request_id is not null then
    return;
  end if;

  select * into v_decision from internal.dead_man_should_fire();

  if v_decision.action = 'fire' then
    v_message := format(
      '🚨 [diktat-workers] no heartbeat drained in >=20 min. Newest done: %s UTC.',
      coalesce(v_decision.newest_done_at::text, '(never)')
    );
    perform internal.dead_man_send(v_message, 'fire');

  elsif v_decision.action = 'recover' then
    v_message := format(
      '✅ [diktat-workers] heartbeat draining again. Prior alert: %s UTC; fresh done: %s UTC.',
      coalesce(v_decision.prior_alert_at::text, '(unknown)'),
      coalesce(v_decision.newest_done_at::text, '(unknown)')
    );
    perform internal.dead_man_send(v_message, 'recover');

  end if;
end;
$fn$;

revoke execute on function internal.dead_man_tick() from public;
grant  execute on function internal.dead_man_tick() to service_role;

commit;
