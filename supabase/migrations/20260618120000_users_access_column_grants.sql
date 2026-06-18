-- Migration: users_access_column_grants
-- Up:   (a) column-level SELECT grant of the public subset to authenticated;
--       (b) SECURITY DEFINER public.get_user_self() returning the caller's
--           full users row, callable only by `authenticated` and locked to
--           auth.uid().
-- Down: revoke the column-level grant; drop the function. See ROLLBACK
--       SCRIPT below for the verbatim sequence.
--
-- Why this exists
-- ---------------
-- PR #41's `20260617160000_public_schema_grants_audit.sql` deliberately
-- EXCLUDED `public.users` because the right shape is column-level
-- (cross-user reads see only the public subset; self reads see the
-- private columns through a SECURITY DEFINER RPC). Today, every
-- `ctx.db.from('users')` read through userScopedClient still 42501s.
-- The PR #41 security-reviewer flagged this gap as forward-looking
-- HIGH H1: "NEVER `grant select on public.users to authenticated` at
-- table level — that would expose `fingerprint` (§12 trust contract),
-- `notification_preferences`, `last_active_at`, `timezone`, and
-- `onboarded_at` to every authenticated session."
--
-- This migration closes H1 by issuing a column-level grant that names
-- only the seven public columns, leaving the private columns
-- (fingerprint, onboarded_at, created_at, updated_at, timezone,
-- last_active_at, notification_preferences) implicitly unreachable by
-- authenticated PostgREST callers — they stay service-role only at the
-- GRANT layer.
--
-- Public subset (PR #41 audit, confirmed against §1 product spec):
--   id              — primary key
--   handle          — citext UNIQUE; public identifier
--   display_name    — public profile label
--   avatar_url      — public profile image
--   current_ap      — public-by-leaderboard-design (§1 "one unified score")
--   tier_id         — public; tier badges shown publicly per §1
--   is_bot          — public; needed for matchmaking opponent filtering
--
-- Private (stay service-role only at the GRANT layer):
--   fingerprint                 — §12 trust contract: never share without asking
--   onboarded_at                — leaks signup time
--   created_at, updated_at      — leak signup time / activity timing
--   timezone                    — leaks location (CLAUDE.md flagged)
--   last_active_at              — leaks activity
--   notification_preferences    — leaks behaviour (push opt-in state)
--
-- Self-only access path
-- ---------------------
-- `get_user_self()` is the only client-callable path to a user's private
-- columns. It is `SECURITY DEFINER` so it runs as the function owner
-- (postgres) and bypasses the column-level GRANT; it is gated to
-- `auth.uid()` inside the function body so the caller cannot read any
-- other user's row, regardless of how they invoke it; and EXECUTE is
-- granted only to `authenticated` (anon cannot call it).
--
-- `search_path = ''` is a deliberate hardening: every identifier inside
-- the function body uses fully-qualified names so a malicious schema
-- placed earlier in a caller's search_path cannot shadow `public.users`
-- or `auth.uid()`.
--
-- Out-of-scope follow-ups (logged in TYRION_BUILD_QUEUE)
-- ------------------------------------------------------
-- This migration intentionally does NOT:
--   - Grant UPDATE on `public.users` to authenticated. The four
--     self-write paths in `apps/api/src/routers/user.ts` (updateHandle,
--     completeOnboarding, updateNotificationPreferences, setTimezone)
--     and matchmaking.ts:115's last_active_at bump continue to 42501.
--     Each needs either a dedicated SECURITY DEFINER mutation RPC or
--     a column-level UPDATE grant — landed in a follow-up scoped to
--     self-write routes.
--   - Expose `onboarded_at` to `apps/web/app/(app)/layout.tsx:32` or
--     `apps/api/src/routers/auth.ts:13`. Both read the caller's own
--     onboarded_at via ctx.db / getServerSupabaseClient and will keep
--     42501ing. The follow-up PR will either add `get_user_session()`
--     SECURITY DEFINER RPC for the auth-session shape OR fold those
--     reads into `get_user_self()` for any caller that needs them.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK SCRIPT (run as postgres / supabase-admin)
-- ---------------------------------------------------------------------------
-- begin;
--
-- revoke select (id, handle, display_name, avatar_url, current_ap, tier_id, is_bot)
--   on public.users from authenticated;
--
-- revoke execute on function public.get_user_self() from authenticated;
-- drop function if exists public.get_user_self();
--
-- commit;
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- (a) Column-level SELECT grant on the public subset.
-- ---------------------------------------------------------------------------
--
-- The pre-existing `users_select_authenticated USING (true)` RLS policy
-- (migration 20260420090002) permits authenticated SELECTs at the row
-- level. Until now the GRANT layer denied every call before RLS even
-- evaluated. This grant lets PostgREST evaluate the policy — but only
-- for the seven columns named below. Selecting any private column via
-- ctx.db.from('users') as `authenticated` continues to fail at
-- column-privilege check.

grant select (id, handle, display_name, avatar_url, current_ap, tier_id, is_bot)
  on public.users to authenticated;

-- ---------------------------------------------------------------------------
-- (b) Self-only access RPC for the private columns.
-- ---------------------------------------------------------------------------

-- The return type is an EXPLICIT column set, NOT `public.users`. This
-- closes round-1 security-reviewer MEDIUM-1: a `returns public.users`
-- function would have `fingerprint`, `timezone`, `last_active_at`,
-- `created_at`, and `updated_at` in the raw RPC payload (SECURITY
-- DEFINER bypasses the column-level GRANT, exposing everything in the
-- row). With the columns spelled out below, those five fields are
-- structurally absent from the return type — `user.me` can't leak them
-- via a future spread refactor because the SDK never sees them.
--
-- `returns table(...)` is set-of semantics (zero-or-one row here),
-- so the supabase-js SDK exposes the result as an array; the router
-- uses `.maybeSingle()` to narrow to {row | null}.
drop function if exists public.get_user_self();
create function public.get_user_self()
returns table (
  id uuid,
  handle extensions.citext,
  display_name text,
  avatar_url text,
  current_ap integer,
  tier_id smallint,
  is_bot boolean,
  onboarded_at timestamptz,
  notification_preferences jsonb
)
language sql
security definer
set search_path = ''
stable
as $$
  -- Lock to the caller's JWT subject. `auth.uid()` returns NULL for
  -- anon callers; the predicate then matches no row and the function
  -- returns empty — which the router maps to NOT_FOUND. The grant
  -- below additionally restricts EXECUTE to `authenticated` so this
  -- defence-in-depth NULL case is only ever reachable as a contract
  -- bug, not as a routine call.
  select
    u.id,
    u.handle,
    u.display_name,
    u.avatar_url,
    u.current_ap,
    u.tier_id,
    u.is_bot,
    u.onboarded_at,
    u.notification_preferences
  from public.users u
  where u.id = auth.uid();
$$;

comment on function public.get_user_self() is
  'Self-only access to the caller''s users row, returning the explicit
   public column set + onboarded_at + notification_preferences.
   Excludes fingerprint, timezone, last_active_at, created_at,
   updated_at — those columns are structurally absent from the
   return type so a future router refactor cannot leak them. SECURITY
   DEFINER bypasses the column-level GRANT; the function body locks
   reads to auth.uid() so a caller cannot fetch another user''s row.';

-- Strip default PUBLIC execute so a misconfigured grant cannot expose
-- this to anon. Re-grant explicitly to authenticated only. service_role
-- retains EXECUTE via the schema-wide grant in
-- 20260427_grant_service_role_public.sql; not re-granted here.
revoke all on function public.get_user_self() from public;
grant execute on function public.get_user_self() to authenticated;

commit;
