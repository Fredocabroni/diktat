-- Migration: Take 5 counts DISTINCT topics per user per local day.
-- Up:   Replace increment_take5_progress(uuid) with
--         increment_take5_progress(uuid, uuid)
--       and rewrite the opinion_shifts trigger to pass new.topic_id.
--       Progress now advances on the FIRST opinion_shift (user, topic,
--       local-today) only; re-taps + stance flips on the same topic
--       within the same local day are no-ops.
-- Down: reference-only (not run) at the tail of this file.
--
-- Design context (P3.a from docs/phase-5/recon-2026-10-08.md):
--   * The pre-#191 Take 5 trigger counted every opinion_shifts INSERT.
--     Operator reproduced the gaming case on their phone: 5 taps on
--     the same card with 5 different client_keys = Take 5 complete.
--   * Michael's spec: "Re-taps and stance flips on the same topic
--     must not add progress."
--   * The composite index on (user_id, topic_id, created_at desc)
--     from migration 20260420090011 already serves the per-topic
--     today-count query cheaply.
--   * `record_opinion_shift(uuid, smallint, uuid)` (migration
--     20261010000000) is the only client-reachable path that INSERTs
--     into opinion_shifts; the trigger fires exclusively on real
--     INSERTs there. ON CONFLICT DO NOTHING retries don't re-fire
--     the trigger (verified by record_opinion_shift.test.sql T2).
--
-- SQL tests (supabase/tests/sql/take5_distinct_topics_per_day.test.sql):
--   1. First shift on topic A → progress 0 → 1
--   2. Second shift on same topic A (different client_key, i.e. a
--      stance flip) → progress stays at 1
--   3. First shift on topic B → progress 1 → 2
--   4. Five taps on one topic by one user → progress ends at 1
--   5. Five distinct topics by one user → progress ends at 5

begin;

-- ---------------------------------------------------------------------------
-- 1) New two-arg writer. Replaces the single-arg function; the trigger
--    below is rewritten to pass new.topic_id. Grants: service_role only.
-- ---------------------------------------------------------------------------
create or replace function public.increment_take5_progress(
  p_user_id  uuid,
  p_topic_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz          text;
  v_today       date;
  v_progress    int;
  v_completed   boolean := false;
  v_shift_count int;
begin
  -- (1) Resolve the user's local calendar day. tz lives on public.users;
  -- a missing user is defensive — the trigger wouldn't fire for an
  -- unknown user, but handle it anyway.
  select timezone into v_tz from public.users where id = p_user_id;
  if v_tz is null then
    return jsonb_build_object('error', 'user_not_found');
  end if;
  v_today := (now() at time zone v_tz)::date;

  -- (2) Distinct-topic gate. The AFTER INSERT trigger context means the
  -- row that triggered us is already visible to this statement's SELECT.
  -- Count rows for (p_user_id, p_topic_id) with (created_at at local tz)
  -- on today's date. If the count is > 1, THIS shift is a repeat (there
  -- was a prior shift on the same topic earlier today) — no progress
  -- credit. If the count is 1, this is the first shift on this topic
  -- today-local and credit applies.
  select count(*)
    into v_shift_count
    from public.opinion_shifts os
   where os.user_id  = p_user_id
     and os.topic_id = p_topic_id
     and (os.created_at at time zone v_tz)::date = v_today;

  if v_shift_count > 1 then
    -- Repeat shift on the same (user, topic, local-today). Return the
    -- current progress unchanged so callers can observe the no-op.
    select take5_progress into v_progress
      from public.streaks where user_id = p_user_id;
    v_progress := coalesce(v_progress, 0);
    return jsonb_build_object(
      'progress', v_progress,
      'completed', v_progress >= 5,
      'local_date', v_today,
      'noop_reason', 'already_counted_this_topic_today'
    );
  end if;

  -- (3) First shift on this topic today-local — advance progress.
  -- Same reset-on-day-change semantics as the pre-P3.a function.
  update public.streaks
    set take5_progress = case
          when take5_local_date is null or take5_local_date < v_today then 1
          else take5_progress + 1
        end,
        take5_local_date = v_today,
        updated_at = now()
   where user_id = p_user_id
   returning take5_progress into v_progress;

  if v_progress is null then
    -- Defensive insert — streaks.user_id is populated by handle_new_user
    -- on every signup, so this branch is unreachable in prod. Kept so a
    -- missing streak row never drops a live engagement.
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

revoke all on function public.increment_take5_progress(uuid, uuid) from public;
grant execute on function public.increment_take5_progress(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2) Trigger rewrite. The AFTER INSERT trigger now passes new.topic_id so
--    the writer can enforce the distinct-topic gate. The outer begin/exception
--    envelope stays — a credit-side failure never blocks the opinion_shifts
--    insert.
-- ---------------------------------------------------------------------------
create or replace function public.opinion_shifts_credit_take5()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform public.increment_take5_progress(new.user_id, new.topic_id);
  exception when others then
    raise warning 'opinion_shifts_credit_take5 failed for user_id=% topic_id=%: %',
      new.user_id, new.topic_id, sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.opinion_shifts_credit_take5() from public;

-- Trigger definition unchanged — only the function body is rewritten.
-- create or replace function above is sufficient; no DROP TRIGGER required.

-- ---------------------------------------------------------------------------
-- 3) Retire the single-arg signature. The only caller was the trigger
--    above, which this migration rewrites to use the two-arg form.
-- ---------------------------------------------------------------------------
drop function if exists public.increment_take5_progress(uuid);

commit;

-- ---------------------------------------------------------------------------
-- Down (reference, not auto-run):
--   drop function if exists public.increment_take5_progress(uuid, uuid);
--   -- Restore the pre-P3.a single-arg function from migration 20260525120000
--   -- + reinstate the single-arg trigger body. See that migration for the
--   -- exact body. The streaks table + composite index are unchanged by this
--   -- migration, so the only rollback is function + trigger bodies.
