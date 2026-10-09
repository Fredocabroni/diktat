-- Migration: Take 5 counts DISTINCT topics per user per local day.
-- Up:   Replace increment_take5_progress(uuid) with
--         increment_take5_progress(uuid, uuid)
--       and rewrite the opinion_shifts trigger to pass new.topic_id.
--       Progress now advances on the FIRST opinion_shift (user, topic,
--       local-today) only; re-taps + stance flips on the same topic
--       within the same local day are no-ops.
-- Down: drop increment_take5_progress(uuid, uuid); restore the single-arg
--       increment_take5_progress(uuid) body from migration
--       20260525120000; rewire opinion_shifts_credit_take5() to call the
--       single-arg form (passing only new.user_id). No table / column /
--       index changes to roll back. See migration 20260525120000 for the
--       exact single-arg body.
--
-- Design context (P3.a from docs/phase-5/recon-2026-10-08.md):
--   * The pre-P3.a Take 5 trigger counted every opinion_shifts INSERT.
--     Operator reproduced the gaming case on their phone: 5 taps on
--     the same card with 5 different client_keys = Take 5 complete.
--   * Michael's spec: "Re-taps and stance flips on the same topic
--     must not add progress."
--   * The composite index on (user_id, topic_id, created_at desc)
--     from migration 20260420090011 already serves the per-topic
--     today-count query cheaply.
--   * record_opinion_shift(uuid, smallint, uuid) (migration
--     20261010000000) is the only client-reachable path that INSERTs
--     into opinion_shifts; the trigger fires exclusively on real
--     INSERTs there. ON CONFLICT DO NOTHING retries don't re-fire
--     the trigger (verified by record_opinion_shift.test.sql T2).
--
-- SQL tests (supabase/tests/sql/take5_distinct_topics_per_day.test.sql):
--   T1 First shift on topic A → progress 0 → 1
--   T2 Stance flip on same topic A (fresh client_key) → progress
--      unchanged + noop_reason stamped
--   T3 First shift on topic B → progress 1 → 2
--   T4 Five taps on one topic by one user → progress ends at 1
--   T5 Five distinct topics by one user → progress ends at 5
--   T6 Prior-day shift does not block today's credit

begin;

-- ---------------------------------------------------------------------------
-- 1) Drop the old single-arg signature FIRST. Only caller was the trigger
--    opinion_shifts_credit_take5, which this migration rewrites to call
--    the two-arg form below. Dropping first removes any ambiguity window
--    inside the transaction (security-reviewer PR #196 Low — ordering).
-- ---------------------------------------------------------------------------
drop function if exists public.increment_take5_progress(uuid);

-- ---------------------------------------------------------------------------
-- 2) New two-arg writer. Enforces the distinct-topic gate: progress credits
--    only on the FIRST opinion_shift for (user, topic, local-today).
--
--    IMPORTANT — trigger-only writer (security-reviewer PR #196 Medium 3):
--    this function MUST NOT be exposed via a tRPC router or PostgREST
--    endpoint. The grant below is service_role-only (not authenticated),
--    and the function trusts p_user_id as supplied — unlike
--    record_opinion_shift / cast_debate_vote / place_prediction, which
--    bind to auth.uid(). The sole legitimate caller is the AFTER INSERT
--    trigger opinion_shifts_credit_take5(), which receives new.user_id
--    from a record_opinion_shift call that already bound to auth.uid()
--    and acquired the per-user advisory lock. Any new caller must either
--    be the trigger or route through record_opinion_shift so the lock +
--    identity binding apply.
--
--    Concurrency (security-reviewer PR #196 Medium 2): the function reads
--    v_shift_count then conditionally UPDATEs streaks. The read + update
--    are serialised against other writers for the same user by
--    SELECT ... FOR UPDATE on the streaks row at the top. That lock
--    is independent of record_opinion_shift's per-user advisory lock,
--    so a hypothetical future writer that bypasses record_opinion_shift
--    (e.g. a service-role backfill) still cannot double-credit.
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
  -- (1) Resolve the user's local calendar day.
  select timezone into v_tz from public.users where id = p_user_id;
  if v_tz is null then
    return jsonb_build_object('error', 'user_not_found');
  end if;
  v_today := (now() at time zone v_tz)::date;

  -- (2) Serialise concurrent trigger invocations for this user. The
  --     advisory lock in record_opinion_shift (migration 20261010000000
  --     line 119) covers the trigger-call path, but a service-role
  --     writer that bypasses that RPC would race the count/update pair
  --     below. FOR UPDATE on the streaks row defeats that race
  --     regardless of how the insert arrived. (security-reviewer
  --     PR #196 Medium 2 — "concurrent stance submissions can double-
  --     credit a single topic"). Mirrors place_prediction's FOR UPDATE
  --     on wallet balance (migration 20260729120000).
  --
  --     If the streaks row is missing (defensive — handle_new_user
  --     inserts it on every signup), skip the lock and fall through to
  --     the defensive INSERT below.
  perform 1 from public.streaks where user_id = p_user_id for update;

  -- (3) Distinct-topic gate. The AFTER INSERT trigger context means the
  --     row that triggered us is already visible to this statement's
  --     SELECT. If the count for (p_user_id, p_topic_id, local-today)
  --     is > 1, THIS shift is a repeat (there was a prior shift on the
  --     same topic earlier today) — no progress credit. If the count
  --     is 1, this is the first shift on this topic today-local and
  --     credit applies.
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

  -- (4) First shift on this topic today-local — advance progress.
  --     Same reset-on-day-change semantics as the pre-P3.a function.
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

  -- `>=` not `=`: if progress has somehow advanced beyond 5 (e.g. a
  -- legacy row from a prior schema), still report completed=true.
  -- (schema-reviewer PR #196 Additional B.)
  if v_progress >= 5 then
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
-- 3) Trigger rewrite. The AFTER INSERT trigger now passes new.topic_id so
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

commit;
