-- Migration: users_self_write_rpcs
-- Up:   four SECURITY DEFINER mutation RPCs locked to auth.uid() for the
--       remaining self-only write paths on public.users that PR #43
--       intentionally left 42501ing — onboarded_at, notification_preferences,
--       timezone, and last_active_at. Each RPC validates its input in the
--       function body (the security boundary, since SECURITY DEFINER
--       bypasses RLS), updates only the caller's own row, and grants
--       EXECUTE to authenticated only.
-- Down: revoke + drop each function. See ROLLBACK SCRIPT below.
--
-- Why this exists
-- ---------------
-- PR #43 (`20260618120000_users_access_column_grants.sql`) closed the
-- forward-looking H1 read-side surface (column-level SELECT grant + the
-- self-only `get_user_self()` RPC) and deferred all self-write paths.
-- Today, every `.from('users').update(...)` call on the user-scoped
-- client 42501s — the four mutation routes in
-- `apps/api/src/routers/user.ts` + matchmaking's last_active_at bump
-- + the (app) layout's onboarded_at read gate + auth.session are
-- empirically dead in production.
--
-- This migration closes the remaining gap via per-route SECURITY
-- DEFINER mutation RPCs (the strict-RLS-as-authority shape we chose
-- over blanket column-level UPDATE grants). Each function:
--   - locks to auth.uid() inside the body — caller cannot write
--     another user's row regardless of how the function is invoked;
--   - validates input in the body — SECURITY DEFINER bypasses RLS,
--     so the function body IS the access-control boundary;
--   - uses set search_path = '' — every identifier is fully qualified
--     so a malicious schema cannot shadow public.users or auth.uid();
--   - revokes EXECUTE from PUBLIC then grants explicitly to
--     authenticated — anon and unauthenticated callers cannot invoke
--     (the inner `if auth.uid() is null` raise is defence-in-depth).
--
-- The two `onboarded_at` reads (auth.session + (app) layout) pivot
-- to the existing `get_user_self()` RPC from PR #43 — same self-lock,
-- same column set, no new function needed.
--
-- Dead-letter RLS policy note (PR #44 round-2 security-reviewer MEDIUM-2)
-- ----------------------------------------------------------------------
-- The pre-existing `users_update_self` RLS policy on public.users
-- (migration 20260420090002:46) authorises self-UPDATEs at the
-- row level. It is currently DEAD-LETTER: no `GRANT UPDATE ON
-- public.users TO authenticated` exists in migration history, so
-- every direct PostgREST UPDATE 42501s at the GRANT layer before
-- RLS is consulted. The four SECURITY DEFINER RPCs below are the
-- only authorised mutation path; the RLS policy is preserved
-- purely so a future direct-grant decision has an obvious row-
-- level safety net to rely on. Auditors should NOT cite the
-- policy as the current access-control surface — that role is
-- played by these RPCs.
--
-- Out-of-scope for THIS migration
-- -------------------------------
--   - updateHandle (UPDATE on public.users.handle). Also 42501s today.
--     Not in the named scope for this PR; can land as a sibling 5th
--     RPC `update_user_handle(p_handle text)` in a follow-up.
--   - Rate limits on the new RPCs. Pre-existing CLAUDE.md TODO +
--     queue. The RPCs are reachable by any authenticated session at
--     unbounded throughput until @fastify/rate-limit registers.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK SCRIPT (run as postgres / supabase-admin)
-- ---------------------------------------------------------------------------
-- begin;
-- revoke execute on function public.complete_onboarding() from authenticated;
-- drop function if exists public.complete_onboarding();
-- revoke execute on function public.update_notification_preferences(jsonb) from authenticated;
-- drop function if exists public.update_notification_preferences(jsonb);
-- revoke execute on function public.set_user_timezone(text) from authenticated;
-- drop function if exists public.set_user_timezone(text);
-- revoke execute on function public.bump_last_active() from authenticated;
-- drop function if exists public.bump_last_active();
-- commit;
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- (1) complete_onboarding() — idempotent + one-way
-- ---------------------------------------------------------------------------
--
-- Stamps `onboarded_at = now()` on first call; returns the existing
-- timestamp on subsequent calls. Cannot un-onboard, cannot backdate.
-- The conditional UPDATE (`WHERE onboarded_at IS NULL`) is atomic at
-- the row level — no race window between a check and a separate write.
create or replace function public.complete_onboarding()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stamped timestamptz;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  update public.users
    set onboarded_at = now()
    where id = auth.uid()
      and onboarded_at is null
    returning onboarded_at into v_stamped;

  if v_stamped is null then
    -- Either the row doesn't exist (shouldn't happen — the auth-user
    -- trigger provisions it) OR onboarded_at was already set. Read
    -- the existing value.
    select onboarded_at into v_stamped
      from public.users
      where id = auth.uid();
    if v_stamped is null then
      raise exception 'user row missing' using errcode = 'P0002';
    end if;
  end if;

  return v_stamped;
end;
$$;

comment on function public.complete_onboarding() is
  'Idempotent + one-way: stamps onboarded_at = now() on first call; returns the existing timestamp on subsequent calls. Locked to auth.uid(). SECURITY DEFINER bypasses RLS; the body is the access boundary.';

revoke all on function public.complete_onboarding() from public;
grant execute on function public.complete_onboarding() to authenticated;

-- ---------------------------------------------------------------------------
-- (2) update_notification_preferences(p_prefs jsonb)
-- ---------------------------------------------------------------------------
--
-- Read-modify-writes notification_preferences for the caller's row.
-- Validates the input shape and key allow-list in the function body
-- before any write — SECURITY DEFINER bypasses RLS, so this is the
-- only check.
create or replace function public.update_notification_preferences(p_prefs jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed_keys text[] := array['streak_risk_push'];
  v_unknown_keys text[];
  v_streak_val jsonb;
  v_merged jsonb;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- (a) Input must be a jsonb object (not array, scalar, or null).
  if p_prefs is null or jsonb_typeof(p_prefs) <> 'object' then
    raise exception 'p_prefs must be a jsonb object'
      using errcode = '22023';
  end if;

  -- (b) All input keys must be in the allowed set. V1 ships exactly
  -- one key (streak_risk_push); future keys add to v_allowed_keys.
  select array_agg(k) into v_unknown_keys
    from jsonb_object_keys(p_prefs) k
    where not (k = any(v_allowed_keys));
  if v_unknown_keys is not null then
    raise exception 'unknown notification preference keys: %', v_unknown_keys
      using errcode = '22023';
  end if;

  -- (c) Type-check each known key's value.
  v_streak_val := p_prefs -> 'streak_risk_push';
  if v_streak_val is not null and jsonb_typeof(v_streak_val) <> 'boolean' then
    raise exception 'streak_risk_push must be a boolean'
      using errcode = '22023';
  end if;

  -- (d) Empty-patch early-exit (PR #44 round-2 security-reviewer
  -- MEDIUM-3). `{} || {}` is identity; skipping the UPDATE avoids the
  -- no-op row lock + WAL entry that a loop-calling abuser could use
  -- as a low-effort contention vector. Read the current value
  -- through the same SECURITY DEFINER privilege so the caller still
  -- gets back the canonical merged shape.
  if p_prefs = '{}'::jsonb then
    select notification_preferences into v_merged
      from public.users
      where id = auth.uid();
    if v_merged is null then
      raise exception 'user row missing' using errcode = 'P0002';
    end if;
    return v_merged;
  end if;

  -- Merge with existing so unprovided keys persist; `||` on jsonb is
  -- right-biased, so the new keys in p_prefs override prior values.
  -- Atomic update eliminates the read-then-write race the router used
  -- to have.
  update public.users
    set notification_preferences = coalesce(notification_preferences, '{}'::jsonb) || p_prefs
    where id = auth.uid()
    returning notification_preferences into v_merged;

  if v_merged is null then
    raise exception 'user row missing' using errcode = 'P0002';
  end if;

  return v_merged;
end;
$$;

comment on function public.update_notification_preferences(jsonb) is
  'Merges a jsonb object into the caller''s notification_preferences. Validates input is an object, all keys are in the allow-list (V1: streak_risk_push), and each value has the expected type. Locked to auth.uid(). SECURITY DEFINER bypasses RLS; the body is the access boundary.';

revoke all on function public.update_notification_preferences(jsonb) from public;
grant execute on function public.update_notification_preferences(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- (3) set_user_timezone(p_tz text)
-- ---------------------------------------------------------------------------
--
-- Validates against pg_catalog.pg_timezone_names — the same catalog
-- that `now() at time zone users.timezone` resolves against in the
-- scheduler's per-user-local sweeps. A value that passes here is
-- guaranteed to resolve downstream.
create or replace function public.set_user_timezone(p_tz text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- Cheap rejection of pathological input before the catalog scan.
  if p_tz is null or char_length(p_tz) = 0 or char_length(p_tz) > 64 then
    raise exception 'timezone must be 1..64 characters' using errcode = '22023';
  end if;

  -- pg_catalog is implicitly on the search_path even when set to '',
  -- but we qualify explicitly so the audit trail is unambiguous.
  if not exists (
    select 1 from pg_catalog.pg_timezone_names where name = p_tz
  ) then
    raise exception 'unknown IANA timezone: %', p_tz using errcode = '22023';
  end if;

  update public.users
    set timezone = p_tz
    where id = auth.uid();

  if not found then
    raise exception 'user row missing' using errcode = 'P0002';
  end if;

  return p_tz;
end;
$$;

comment on function public.set_user_timezone(text) is
  'Sets the caller''s timezone column. Validates length (1..64 chars) + existence in pg_catalog.pg_timezone_names. Locked to auth.uid(). SECURITY DEFINER bypasses RLS; the body is the access boundary.';

revoke all on function public.set_user_timezone(text) from public;
grant execute on function public.set_user_timezone(text) to authenticated;

-- ---------------------------------------------------------------------------
-- (4) bump_last_active()
-- ---------------------------------------------------------------------------
--
-- Stamps last_active_at = server's `now()`. No input — the caller can't
-- pass a backdated timestamp, can't replay an arbitrary moment.
create or replace function public.bump_last_active()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  update public.users
    set last_active_at = v_now
    where id = auth.uid();

  if not found then
    raise exception 'user row missing' using errcode = 'P0002';
  end if;

  return v_now;
end;
$$;

comment on function public.bump_last_active() is
  'Stamps the caller''s last_active_at to the server''s now(). No input — caller cannot backdate or replay. Locked to auth.uid(). SECURITY DEFINER bypasses RLS; the body is the access boundary.';

revoke all on function public.bump_last_active() from public;
grant execute on function public.bump_last_active() to authenticated;

commit;
