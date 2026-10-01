-- Migration: harden internal.dead_man_send + add next-tick delivery check (#147).
-- Up:   extend internal.dead_man_state with `last_send_request_id` and
--       `pending_action`; redefine internal.dead_man_send to validate
--       the Telegram token shape and stash the pending action +
--       request_id before http_post; redefine internal.dead_man_tick
--       to confirm the previous send's delivery via net._http_response
--       BEFORE issuing a new one.
-- Down: see `-- Rollback (reference, not auto-run):` block below —
--       drop the new columns + CREATE OR REPLACE the functions back
--       to their 20260929230000 shape.
--
-- Motivation (follow-up on #147, round-2 security review on PRs #140 /
-- #141):
--
--   1. Bot token injected into URL path without format validation. A
--      mis-pasted Vault secret produces a malformed URL that pg_net
--      silently 404s on; the DMS marks itself "already fired" via the
--      1-hour dedup and the operator gets nothing. FIX: new RAISE
--      guard rejects any token that doesn't match Telegram's
--      `<botid>:<hash>` shape at send time.
--
--   2. pg_net is async — a wrong-but-non-null bot token silently
--      advances the suppression state without ever delivering an
--      alert. FIX: `dead_man_record('fire')` is NOT called inline from
--      dead_man_send any more. The tick orchestrator confirms delivery
--      on the FOLLOWING tick by checking net._http_response for the
--      previous send's request_id. On 200 it records the pending
--      action; on non-200 (or a timeout) it emits a NOTICE and clears
--      the pending flag so the next cycle re-synthesises.
--
--   3. (Separately, round-2 M3) dead_man_should_fire was SECURITY
--      INVOKER. Left as-is in this migration — the function reads
--      public.scheduled_jobs + internal.dead_man_state only, and
--      internal is already REVOKEd from client roles. Converting to
--      SECURITY DEFINER would require more care around the function's
--      callers (dead_man_tick, which runs as the owner anyway); keep
--      the posture explicit via a stricter review when that need
--      actually materialises. Filed in-line as a TODO comment.
--
-- Rollback (reference, not auto-run):
--   create or replace function internal.dead_man_send(p_message text)
--     returns bigint ... (restore 20260929230000's body);
--   create or replace function internal.dead_man_tick() ... (restore
--     20260929230000's body);
--   alter table internal.dead_man_state
--     drop column if exists last_send_request_id,
--     drop column if exists pending_action;

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. State schema extension
-- ───────────────────────────────────────────────────────────────────────────

alter table internal.dead_man_state
  add column if not exists last_send_request_id bigint,
  add column if not exists pending_action text
    check (pending_action is null or pending_action in ('fire', 'recover'));

comment on column internal.dead_man_state.last_send_request_id is
  'pg_net.http_post request id from the most recent dead_man_send call. '
  'Cleared by the next tick after delivery is confirmed via '
  'net._http_response.';
comment on column internal.dead_man_state.pending_action is
  'Which record() call to run after the next tick confirms the most '
  'recent send delivered. ''fire'' or ''recover'', else null when no '
  'send is in flight.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. dead_man_send: validate token shape, stash pending state, POST.
--
-- Shape change from 20260929230000: now takes `p_action` so the tick
-- knows what to record on delivery confirmation. Callers inside this
-- migration pass 'fire' or 'recover'; manual wiring tests from the
-- SQL editor can pass 'fire' (the state will get cleared by the next
-- tick's confirmation).
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
  -- Rejects an obviously-malformed secret (mis-paste, wrong secret
  -- name typo'd on the dashboard side) so dead_man_tick doesn't mark
  -- the DMS "already fired" against a URL that will 404 anyway.
  if v_token !~ '^[0-9]+:[A-Za-z0-9_-]+$' then
    raise exception
      'dead_man_send: token has invalid shape (expected <botid>:<hash>, got length=%)',
      length(v_token);
  end if;

  -- #147 M2: issue the http_post, capture its async request_id, write
  -- it to the state row BEFORE returning. dead_man_record() is NOT
  -- called inline any more. The next tick's dead_man_tick() reads
  -- net._http_response for this request_id and only then records the
  -- action.
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

  update internal.dead_man_state
    set last_send_request_id = v_request,
        pending_action       = p_action
    where id = 1;

  return v_request;
end;
$fn$;

revoke execute on function internal.dead_man_send(text, text) from public;
grant  execute on function internal.dead_man_send(text, text) to service_role;

-- Drop the old 1-arg shape so stale callers crash loudly instead of
-- using a signature that doesn't exist any more. (The original migration
-- defined internal.dead_man_send(p_message text) — dropping it ensures
-- a developer who copies the old wiring-test SQL gets an "undefined
-- function" error, not a silent miscall.)
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
begin
  select * into v_state from internal.dead_man_state where id = 1;

  -- Step 1: confirm the previous send's delivery, if one is pending.
  if v_state.last_send_request_id is not null then
    select status_code, error_msg, timed_out
      into v_response
      from net._http_response
      where id = v_state.last_send_request_id;

    if not found then
      -- pg_net hasn't landed a response yet. Keep waiting until the
      -- next tick (5 min out). Normal Telegram POST latency is ~1s;
      -- if we still have no row after 5 min the request is wedged —
      -- clear the pending flag so the next cycle re-synthesises
      -- fresh. 2 ticks (10 min) is the grace window.
      if v_state.last_alert_at is not null
         and v_state.last_alert_at < now() - interval '10 minutes' then
        raise notice 'dead_man_tick: send request_id=% has no net._http_response row after >10min; clearing to resynthesise',
          v_state.last_send_request_id;
        update internal.dead_man_state
          set last_send_request_id = null,
              pending_action       = null
          where id = 1;
      end if;
      return;
    end if;

    if v_response.status_code = 200
       and v_response.error_msg is null
       and coalesce(v_response.timed_out, false) = false then
      -- Delivered. Record the pending action, clear the pending flag.
      perform internal.dead_man_record(v_state.pending_action);
      update internal.dead_man_state
        set last_send_request_id = null,
            pending_action       = null
        where id = 1;
    else
      -- Delivery failed. Emit a NOTICE visible in prod logs; clear
      -- the pending flag so the next cycle re-synthesises instead of
      -- treating this as "already alerted" via the dedup window.
      raise notice 'dead_man_tick: send request_id=% delivery failed (status=%, error_msg=%, timed_out=%)',
        v_state.last_send_request_id,
        v_response.status_code,
        v_response.error_msg,
        v_response.timed_out;
      update internal.dead_man_state
        set last_send_request_id = null,
            pending_action       = null
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
  -- 'quiet' and 'suppress' → do nothing this cycle.
end;
$fn$;

revoke execute on function internal.dead_man_tick() from public;
grant  execute on function internal.dead_man_tick() to service_role;

commit;
