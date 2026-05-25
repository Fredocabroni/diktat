-- Migration: streak_engine — PR 4.4
-- Up:
--   1. Extend public.streaks with 4 columns for Take 5 progress + per-user
--      freeze inventory cap + last-freeze-used tracking.
--   2. Three SECURITY DEFINER SQL functions as the atomic write boundary:
--        - increment_take5_progress(user_id)
--        - apply_local_boundary_sweep(user_id, yesterday)
--        - evaluate_risk_push(user_id, local_date)
--   3. AFTER INSERT trigger on public.opinion_shifts that auto-credits Take 5
--      progress via increment_take5_progress. Exception-safe: a credit-side
--      failure must not block the opinion insert. Logs WARNING and continues.
--   4. Two pg_cron entries on top of the PR #25 scheduler spine:
--        - local_boundary_sweep — every */15, emits one row per user per
--          local day when their local time is 00:00–00:14.
--        - risk_push_check — every */15, emits one row per user per local
--          day when their local time is 21:00–21:14 AND they have a streak
--          to lose AND Take 5 is incomplete today.
--      Both use scheduled_jobs.target_user_id + per-user-local-date
--      idempotency, so the same user gets at most one row per local day
--      per job_type.
--
-- Down (reference, not auto-run):
--   select cron.unschedule('local_boundary_sweep');
--   select cron.unschedule('risk_push_check');
--   drop trigger if exists opinion_shifts_take5_after_insert on public.opinion_shifts;
--   drop function if exists public.opinion_shifts_credit_take5();
--   drop function if exists public.evaluate_risk_push(uuid, date);
--   drop function if exists public.apply_local_boundary_sweep(uuid, date);
--   drop function if exists public.increment_take5_progress(uuid);
--   alter table public.streaks
--     drop column if exists freeze_tokens_max,
--     drop column if exists last_freeze_used_local_date,
--     drop column if exists take5_local_date,
--     drop column if exists take5_progress;
--
-- Design context (full scope in PR 4.4 plan):
--   * Take 5 = the daily mission of 5 qualifying engagements per local day
--     (MASTER_PLAN.md §6 line 178). It is the trigger for a streak day to
--     count. Take 5 is NOT grace days.
--   * Freeze = the post-hoc rescue for a Take-5-incomplete day. Earned 1
--     per 7-day streak milestone, capped at 2 banked, 1 use per local day
--     max. ADDICTION §11.3 (no hidden AP cost) + §11.7 (fixed cadence, not
--     monetized) compliant.
--   * Streak BREAK is silent: no notification, no guilt CTA. §11.5.
--   * risk_push fires only at user-local 21:00–21:14, only when streak
--     > 0, only when Take 5 incomplete. Categorically banned at 23:00 per
--     §12 ("11 PM re-engagement pushes → trust down. Never.").
--   * PR 4.4 ships decision-and-scheduling for risk_push only. Actual web
--     push delivery is deferred to a future PR that consumes the
--     scheduled_jobs trail (job_type='risk_push', status='done',
--     payload->>'decision' = 'would_push').

begin;

-- ---------------------------------------------------------------------------
-- 1) Extend public.streaks.
-- ---------------------------------------------------------------------------

alter table public.streaks
  add column if not exists take5_progress int not null default 0
    check (take5_progress >= 0),
  add column if not exists take5_local_date date,
  add column if not exists last_freeze_used_local_date date,
  add column if not exists freeze_tokens_max int not null default 2
    check (freeze_tokens_max >= 0);

-- ---------------------------------------------------------------------------
-- 2a) increment_take5_progress
-- ---------------------------------------------------------------------------
-- Atomic per-engagement credit. Reads the user's timezone, computes their
-- local today, and either resets take5_progress (new local day) or
-- increments it (same local day). Single UPDATE inside the implicit
-- function transaction.

create or replace function public.increment_take5_progress(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_today date;
  v_progress int;
  v_completed boolean := false;
begin
  select timezone into v_tz from public.users where id = p_user_id;
  if v_tz is null then
    return jsonb_build_object('error', 'user_not_found');
  end if;
  v_today := (now() at time zone v_tz)::date;

  update public.streaks
  set
    take5_progress = case
      when take5_local_date is null or take5_local_date < v_today then 1
      else take5_progress + 1
    end,
    take5_local_date = v_today,
    updated_at = now()
  where user_id = p_user_id
  returning take5_progress into v_progress;

  if v_progress is null then
    -- Streak row missing (should be impossible — handle_new_user inserts it).
    -- Defensive insert + retry so live engagements aren't lost.
    insert into public.streaks (user_id, take5_progress, take5_local_date)
    values (p_user_id, 1, v_today)
    on conflict (user_id) do update
      set take5_progress = 1, take5_local_date = v_today, updated_at = now();
    v_progress := 1;
  end if;

  if v_progress = 5 then
    v_completed := true;
  end if;

  return jsonb_build_object(
    'progress', v_progress,
    'completed', v_completed,
    'local_date', v_today
  );
end;
$$;

revoke all on function public.increment_take5_progress(uuid) from public;
grant execute on function public.increment_take5_progress(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2b) apply_local_boundary_sweep
-- ---------------------------------------------------------------------------
-- Atomic per-user streak compute, called by the local_boundary_sweep
-- handler when the user's local midnight has just passed. p_yesterday is
-- the local date that just ended.
--
-- Outcomes:
--   - 'already_swept'  — re-fire defense; last_action_date already >= yesterday
--   - 'advanced'       — Take 5 completed yesterday → current_length++
--                         + milestone freeze grant at length % 7 == 0
--   - 'frozen'         — Take 5 missed yesterday but a freeze rescued
--                         → current_length preserved (NOT advanced)
--                         + freeze_tokens decremented + last_freeze_used set
--   - 'broken'         — Take 5 missed and no freeze available
--                         → current_length := 0
--   - 'streak_not_found' — defensive; streak row missing
--
-- All branches reset take5_progress + take5_local_date for the new local day.

create or replace function public.apply_local_boundary_sweep(
  p_user_id uuid,
  p_yesterday date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.streaks%rowtype;
  v_new_length int;
  v_new_freezes int;
  v_milestone_granted boolean := false;
begin
  select * into v_row from public.streaks where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('outcome', 'streak_not_found');
  end if;

  -- Idempotent re-fire guard: if we already swept up to this yesterday,
  -- the row's state is already correct.
  if v_row.last_action_date is not null and v_row.last_action_date >= p_yesterday then
    return jsonb_build_object('outcome', 'already_swept');
  end if;

  if v_row.take5_local_date = p_yesterday and v_row.take5_progress >= 5 then
    -- Advance.
    v_new_length := v_row.current_length + 1;
    v_new_freezes := v_row.freeze_tokens;
    if v_new_length % 7 = 0 and v_row.freeze_tokens < v_row.freeze_tokens_max then
      v_new_freezes := v_row.freeze_tokens + 1;
      v_milestone_granted := true;
    end if;
    update public.streaks
    set
      current_length = v_new_length,
      longest_length = greatest(longest_length, v_new_length),
      last_action_date = p_yesterday,
      freeze_tokens = v_new_freezes,
      take5_progress = 0,
      take5_local_date = null,
      updated_at = now()
    where user_id = p_user_id;
    return jsonb_build_object(
      'outcome', 'advanced',
      'new_length', v_new_length,
      'freezes', v_new_freezes,
      'milestone_granted', v_milestone_granted
    );
  elsif v_row.freeze_tokens > 0
        and (v_row.last_freeze_used_local_date is null
             or v_row.last_freeze_used_local_date < p_yesterday) then
    -- Freeze rescue. current_length is preserved, NOT advanced.
    update public.streaks
    set
      freeze_tokens = freeze_tokens - 1,
      last_freeze_used_local_date = p_yesterday,
      last_action_date = p_yesterday,
      take5_progress = 0,
      take5_local_date = null,
      updated_at = now()
    where user_id = p_user_id;
    return jsonb_build_object(
      'outcome', 'frozen',
      'new_length', v_row.current_length,
      'freezes', v_row.freeze_tokens - 1
    );
  else
    -- Break (silent — no notification emitted from this path).
    update public.streaks
    set
      current_length = 0,
      last_action_date = p_yesterday,
      take5_progress = 0,
      take5_local_date = null,
      updated_at = now()
    where user_id = p_user_id;
    return jsonb_build_object(
      'outcome', 'broken',
      'new_length', 0
    );
  end if;
end;
$$;

revoke all on function public.apply_local_boundary_sweep(uuid, date) from public;
grant execute on function public.apply_local_boundary_sweep(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- 2c) evaluate_risk_push
-- ---------------------------------------------------------------------------
-- Read-only decision function. Called by the risk_push handler at user-
-- local 21:00. Does NOT deliver — that's the future web-push PR.
--
-- Decision branches:
--   - 'skip_no_streak' — no row, or current_length = 0
--   - 'skip_completed' — Take 5 already done today
--   - 'would_push'     — Take 5 incomplete today AND user has a streak
--                         to lose. Payload carries length/progress/freezes
--                         so the future delivery PR can frame copy.

create or replace function public.evaluate_risk_push(
  p_user_id uuid,
  p_local_date date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.streaks%rowtype;
begin
  select * into v_row from public.streaks where user_id = p_user_id;
  if not found then
    return jsonb_build_object('decision', 'skip_no_streak');
  end if;
  if v_row.take5_local_date = p_local_date and v_row.take5_progress >= 5 then
    return jsonb_build_object('decision', 'skip_completed');
  end if;
  if v_row.current_length = 0 then
    return jsonb_build_object('decision', 'skip_no_streak');
  end if;
  return jsonb_build_object(
    'decision', 'would_push',
    'current_length', v_row.current_length,
    'progress', v_row.take5_progress,
    'freezes', v_row.freeze_tokens,
    'freezes_max', v_row.freeze_tokens_max
  );
end;
$$;

revoke all on function public.evaluate_risk_push(uuid, date) from public;
grant execute on function public.evaluate_risk_push(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- 3) Trigger: credit Take 5 on opinion_shifts inserts.
-- ---------------------------------------------------------------------------
-- Exception-safe wrapper. A credit-side failure must not block the
-- underlying opinion record — opinion_shifts is the source of truth for
-- the user's stated view; streak credit is a derived signal. Failures log
-- a WARNING and are swallowed.

create or replace function public.opinion_shifts_credit_take5()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform public.increment_take5_progress(new.user_id);
  exception when others then
    raise warning 'opinion_shifts_credit_take5 failed for user_id=%: %',
      new.user_id, sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.opinion_shifts_credit_take5() from public;

create trigger opinion_shifts_take5_after_insert
  after insert on public.opinion_shifts
  for each row execute function public.opinion_shifts_credit_take5();

-- ---------------------------------------------------------------------------
-- 4) pg_cron entries.
-- ---------------------------------------------------------------------------
-- cron.schedule(name, ...) is idempotent by name — re-running this migration
-- upserts the schedules rather than erroring.

-- local_boundary_sweep — every */15. Emits one row per user per local day
-- in the 00:00–00:14 window. ON CONFLICT DO NOTHING makes later 15-min
-- ticks in the same window no-op.
select cron.schedule(
  'local_boundary_sweep',
  '*/15 * * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, target_user_id, idempotency_key, payload)
    select 'local_boundary_sweep',
           u.id,
           to_char((now() at time zone u.timezone)::date, 'YYYY-MM-DD'),
           jsonb_build_object(
             'yesterday',
             to_char(((now() at time zone u.timezone)::date - interval '1 day')::date, 'YYYY-MM-DD'),
             'user_tz', u.timezone,
             'emitted_at_local', to_char(now() at time zone u.timezone, 'YYYY-MM-DD HH24:MI:SS')
           )
    from public.users u
    where u.is_bot = false
      and extract(hour from now() at time zone u.timezone) = 0
      and extract(minute from now() at time zone u.timezone) < 15
    on conflict (job_type, target_user_id, idempotency_key) where target_user_id is not null
    do nothing;
  $cron$
);

-- risk_push_check — every */15. Emits one row per user per local day in
-- the 21:00–21:14 window, only for users with an active streak AND Take 5
-- incomplete. Pre-filtering reduces noise; the handler re-verifies via
-- evaluate_risk_push (state may change in the 15 min between cron tick
-- and handler claim — e.g., user completes Take 5 at 21:05).
select cron.schedule(
  'risk_push_check',
  '*/15 * * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, target_user_id, idempotency_key, payload)
    select 'risk_push',
           u.id,
           to_char((now() at time zone u.timezone)::date, 'YYYY-MM-DD'),
           jsonb_build_object(
             'local_date',
             to_char((now() at time zone u.timezone)::date, 'YYYY-MM-DD'),
             'user_tz', u.timezone,
             'emitted_at_local', to_char(now() at time zone u.timezone, 'YYYY-MM-DD HH24:MI:SS')
           )
    from public.users u
    join public.streaks s on s.user_id = u.id
    where u.is_bot = false
      and s.current_length > 0
      and (s.take5_local_date is null
           or s.take5_local_date < (now() at time zone u.timezone)::date
           or s.take5_progress < 5)
      and extract(hour from now() at time zone u.timezone) = 21
      and extract(minute from now() at time zone u.timezone) < 15
    on conflict (job_type, target_user_id, idempotency_key) where target_user_id is not null
    do nothing;
  $cron$
);

commit;
