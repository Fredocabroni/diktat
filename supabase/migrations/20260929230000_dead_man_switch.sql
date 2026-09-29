-- Migration: dead-man's switch for the workers process (Issue #127 PR B).
--
-- Problem: the Telegram alerter lives INSIDE the workers process. When the
-- process dies, the alerter dies with it — no in-process code path can
-- detect its own death. Solution: an out-of-process check, running in
-- pg_cron, that fires a Telegram POST via `pg_net` when the workers stop
-- draining `heartbeat` scheduled_jobs rows.
--
-- Design (Issue #127 PR B revised):
--   * Staleness signal: newest `scheduled_jobs` row where job_type='heartbeat'
--     AND status='done' is older than 20 min. Uses `done` (not pending) so a
--     dead pg_cron catches too — no pending means no new done either.
--   * Split: `dead_man_should_fire()` is a pure SQL decision (SECURITY
--     INVOKER, no side effects). `dead_man_record(action)` is pure
--     bookkeeping (SECURITY DEFINER, no HTTP). `dead_man_send(message)` is
--     HTTP-only (SECURITY DEFINER, reads vault, POSTs via pg_net). The
--     `dead_man_tick()` orchestrator calls them in sequence.
--   * State: single-row `internal.dead_man_state` (`check id=1`). Tracks
--     last_action + last_alert_at + last_recover_at for dedup (1h re-alert
--     window) and recovery detection.
--   * Cadence: `workers_liveness_check` cron runs every 5 min. In addition,
--     THIS migration ALSO tightens the existing `scheduler_heartbeat` cron
--     from `*/15 * * * *` to `*/5 * * * *` — with a 15-min heartbeat and a
--     20-min staleness threshold the false-positive slack against a
--     ~9-min workers redeploy was too tight.
--
-- Grants + search_path posture: Postgres grants EXECUTE to PUBLIC by default
-- on `create function`. Every new function here revokes from PUBLIC and
-- grants only to service_role. Every SECURITY DEFINER function pins
-- `search_path = ''` so no schema-hijack surface exists — every reference
-- is fully qualified. `dead_man_should_fire()` is SECURITY INVOKER (pure
-- reads from public.scheduled_jobs + internal.dead_man_state).
--
-- POST-DEPLOY MANUAL STEPS (documented in the PR body):
--   1. Insert Telegram creds via the Supabase Dashboard's Vault UI (never
--      via the SQL editor — SQL editor keeps browser + server query
--      history). Path: Project Settings → Vault → Add new secret. Names
--      MUST be exactly:
--        - dead_man_telegram_bot_token
--        - dead_man_telegram_chat_id
--   2. Fire a wiring test:
--        select internal.dead_man_send('🧪 DMS wiring test · '||now()::text);
--      Confirm BOTH:
--        (a) phone receives the test message in the Telegram channel;
--        (b) `select status_code, error_msg, timed_out from net._http_response
--             where created > now() - interval '5 minutes' order by created
--             desc limit 1;` returns status_code=200, error_msg=null,
--             timed_out=false.
--      Diagnostics (Telegram Bot API contract):
--        - 200: message delivered.
--        - 400 with error `chat not found`: chat id wrong OR bot has not
--          been added to that chat.
--        - 401: bot token missing / malformed.
--        - 404: bot token wrong (Telegram treats invalid tokens as an
--          unknown API path).
--   3. After the wiring test passes, reset state:
--        update internal.dead_man_state
--          set last_action='quiet', last_alert_at=null, last_recover_at=null
--          where id=1;
--
-- Reversibility (down direction, for reference):
--   select cron.unschedule('workers_liveness_check');
--   -- Restore scheduler_heartbeat to */15:
--   select cron.schedule('scheduler_heartbeat', '*/15 * * * *', $$
--     insert into public.scheduled_jobs (job_type, idempotency_key)
--     values ('heartbeat', to_char(now(), 'YYYY-MM-DD HH24:MI'))
--     on conflict (job_type, idempotency_key) where target_user_id is null
--     do nothing;
--   $$);
--   drop function if exists internal.dead_man_tick();
--   drop function if exists internal.dead_man_send(text);
--   drop function if exists internal.dead_man_record(text);
--   drop function if exists internal.dead_man_should_fire();
--   drop table if exists internal.dead_man_state;

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Extensions + schema
-- ───────────────────────────────────────────────────────────────────────────

-- pg_net is Supabase's async HTTP client, used here to POST to Telegram from
-- inside a pg_cron function body without blocking the executor.
create extension if not exists pg_net;

create schema if not exists internal;
comment on schema internal is
  'Server-side internal state and functions. NEVER granted to authenticated / anon.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. State table
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists internal.dead_man_state (
  id                bigint       primary key check (id = 1),
  last_action       text         not null default 'quiet'
                                   check (last_action in ('quiet', 'fire')),
  last_alert_at     timestamptz  null,
  last_recover_at   timestamptz  null
);
comment on table internal.dead_man_state is
  'Single-row DMS state. `id=1` invariant. Never accessed by client code.';

insert into internal.dead_man_state (id, last_action)
values (1, 'quiet')
on conflict (id) do nothing;

-- Lock the table down — no client role should ever read or write it.
revoke all on internal.dead_man_state from public;
grant  select, insert, update on internal.dead_man_state to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Pure decision: dead_man_should_fire()
--
-- Reads newest 'done' heartbeat + state, returns action + snapshot values.
-- No writes. No HTTP. Fully SQL-testable (see supabase/tests/sql/
-- dead_man_switch.test.sql).
-- ───────────────────────────────────────────────────────────────────────────

create or replace function internal.dead_man_should_fire()
returns table (
  action           text,
  newest_done_at   timestamptz,
  prior_alert_at   timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_newest_done  timestamptz;
  v_state        internal.dead_man_state%rowtype;
  v_stale        boolean;
  v_recent_alert boolean;
begin
  -- Newest 'done' heartbeat is the round-trip liveness signal.
  select max(processed_at)
    into v_newest_done
  from public.scheduled_jobs
  where job_type = 'heartbeat'
    and status = 'done';

  select * into v_state from internal.dead_man_state where id = 1;

  -- Staleness = newest done is null (no heartbeat has ever completed) OR
  -- newer than 20 min ago.
  v_stale := v_newest_done is null
             or v_newest_done < now() - interval '20 minutes';

  v_recent_alert := v_state.last_alert_at is not null
                    and v_state.last_alert_at > now() - interval '1 hour';

  if not v_stale then
    if v_state.last_action = 'fire' then
      -- Was firing, heartbeat draining again → send 'back online' once.
      action := 'recover';
    else
      action := 'quiet';
    end if;
  else
    if v_recent_alert then
      -- Stuck AND already alerted <1h ago → suppress this cycle.
      action := 'suppress';
    else
      action := 'fire';
    end if;
  end if;

  newest_done_at := v_newest_done;
  prior_alert_at := v_state.last_alert_at;
  return next;
end;
$fn$;

revoke execute on function internal.dead_man_should_fire() from public;
grant  execute on function internal.dead_man_should_fire() to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Pure bookkeeping: dead_man_record(action)
--
-- Writes to internal.dead_man_state. No HTTP.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function internal.dead_man_record(p_action text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_action = 'fire' then
    update internal.dead_man_state
       set last_action   = 'fire',
           last_alert_at = now()
     where id = 1;
  elsif p_action = 'recover' then
    update internal.dead_man_state
       set last_action     = 'quiet',
           last_recover_at = now()
     where id = 1;
  else
    -- Catches typos in the orchestrator or a caller passing 'quiet' /
    -- 'suppress' — those actions must not call record() at all.
    raise exception 'dead_man_record: unknown action %', p_action;
  end if;
end;
$fn$;

revoke execute on function internal.dead_man_record(text) from public;
grant  execute on function internal.dead_man_record(text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. HTTP sender: dead_man_send(message)
--
-- Reads Telegram creds from vault.decrypted_secrets. Fires net.http_post().
-- No state writes AT ALL. RAISES if either secret is missing or null so
-- dead_man_tick() never records 'fire' when nothing could be sent.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function internal.dead_man_send(p_message text)
returns bigint  -- pg_net request id, useful for correlating to net._http_response
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_token    text;
  v_chat_id  text;
  v_request  bigint;
begin
  -- Read both secrets by name. LEFT-JOIN semantics via subquery so a
  -- missing row shows up as NULL rather than "no rows returned".
  select decrypted_secret into v_token
    from vault.decrypted_secrets
   where name = 'dead_man_telegram_bot_token';

  select decrypted_secret into v_chat_id
    from vault.decrypted_secrets
   where name = 'dead_man_telegram_chat_id';

  -- Fail loud if either secret is missing or empty. If we silently no-op,
  -- dead_man_tick() would still call record('fire'), and the state row
  -- would advance to last_action='fire' with last_alert_at=now() — the
  -- outage would look "already alerted" for the next hour while nothing
  -- had actually been sent. RAISING here means the tick's INSERT/UPDATE
  -- to internal.dead_man_state rolls back with the send.
  if v_token is null or length(v_token) = 0 then
    raise exception 'dead_man_send: vault secret dead_man_telegram_bot_token is missing or empty';
  end if;
  if v_chat_id is null or length(v_chat_id) = 0 then
    raise exception 'dead_man_send: vault secret dead_man_telegram_chat_id is missing or empty';
  end if;

  -- POST to Telegram Bot API. pg_net is async — this returns immediately
  -- with a request id; the actual response lands in net._http_response.
  -- Both status_code and error_msg from that table are the source of truth
  -- for whether the message was delivered (see migration header for the
  -- HTTP contract Telegram enforces).
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

  return v_request;
end;
$fn$;

revoke execute on function internal.dead_man_send(text) from public;
grant  execute on function internal.dead_man_send(text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Orchestrator: dead_man_tick()
--
-- The pg_cron entry calls this every 5 min. Reads should_fire, dispatches
-- send + record in sequence. If send() raises (missing vault secret,
-- pg_net error), the tick errors out and record() is NOT called — the
-- state row is unchanged. Next tick tries again.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function internal.dead_man_tick()
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_decision  record;
  v_message   text;
begin
  select * into v_decision from internal.dead_man_should_fire();

  if v_decision.action = 'fire' then
    v_message := format(
      '🚨 [diktat-workers] no heartbeat drained in >=20 min. Newest done: %s UTC.',
      coalesce(v_decision.newest_done_at::text, '(never)')
    );
    perform internal.dead_man_send(v_message);
    perform internal.dead_man_record('fire');

  elsif v_decision.action = 'recover' then
    v_message := format(
      '✅ [diktat-workers] heartbeat draining again. Prior alert: %s UTC; fresh done: %s UTC.',
      coalesce(v_decision.prior_alert_at::text, '(unknown)'),
      coalesce(v_decision.newest_done_at::text, '(unknown)')
    );
    perform internal.dead_man_send(v_message);
    perform internal.dead_man_record('recover');

  end if;
  -- 'quiet' and 'suppress' → do nothing this cycle.
end;
$fn$;

revoke execute on function internal.dead_man_tick() from public;
grant  execute on function internal.dead_man_tick() to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Cron entries
--
-- (a) workers_liveness_check: the new DMS orchestrator, every 5 min.
-- (b) scheduler_heartbeat: retighten cadence from */15 to */5. `cron.schedule`
--     upserts by name — this modifies the existing entry in place, no
--     unschedule needed.
--
-- The scheduler_heartbeat cron body is copied VERBATIM from the source at
-- supabase/migrations/20260522_scheduler_spine.sql:176-181; only the schedule
-- string changes.
-- ───────────────────────────────────────────────────────────────────────────

select cron.schedule(
  'workers_liveness_check',
  '*/5 * * * *',
  $cron$ select internal.dead_man_tick(); $cron$
);

select cron.schedule(
  'scheduler_heartbeat',
  '*/5 * * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key)
    values ('heartbeat', to_char(now(), 'YYYY-MM-DD HH24:MI'))
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

commit;
