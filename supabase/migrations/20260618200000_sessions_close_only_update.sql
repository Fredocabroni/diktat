-- Migration: sessions_close_only_update
-- Up:   (a) revoke table-level UPDATE on sessions; (b) re-grant column-
--       level UPDATE on ONLY ended_at; (c) tighten sessions_update_self
--       WITH CHECK so the only legal UPDATE shape is "close this open
--       session with a near-now timestamp."
-- Down: drop the tightened policy, restore the loose WITH CHECK, revoke
--       the scoped column grant, restore the table-level UPDATE grant.
--       See ROLLBACK SCRIPT below.
--
-- Why this exists
-- ---------------
-- PR #41's grants audit activated `grant select, insert, update on
-- public.sessions to authenticated` (20260617160000:170) for the day a
-- writer would ship. The day-zero state is now structurally permissive
-- on UPDATE:
--
--   - Table-level UPDATE is granted; per-column grants cascade to all
--     7 columns (id, user_id, started_at, ended_at, device_kind,
--     app_version, created_at).
--   - The existing UPDATE policy is:
--       USING      (is_self(user_id) AND ended_at IS NULL)
--       WITH CHECK (is_self(user_id))
--     The USING limits which rows are reachable to the caller's own
--     open sessions. Once USING passes, the WITH CHECK validates only
--     the user_id binding. Every other column on the post-image is
--     unconstrained.
--
-- A self-update on an open session can therefore:
--   - rewrite started_at to any past or future value;
--   - set ended_at to a far-future timestamp ("session length = 1000
--     years");
--   - rewrite device_kind, app_version, created_at, even id.
--
-- The fork question — does anything read sessions.started_at or
-- duration into a rewarded / competitive / streak metric (AP,
-- leaderboards, streaks, "time played") — was answered NO across the
-- whole codebase. Every started_at/ended_at code reference outside the
-- generated db types targets `battles` or `debates`, not `sessions`.
-- The 30-minute session-length nudge (ADDICTION_ARCHITECTURE.md §12)
-- runs entirely client-side from localStorage + Date.now(); it never
-- queries the sessions table. The streak engine credits Take 5 from
-- `opinion_shifts` INSERTs via trigger; no path reads session duration.
-- `sessions` is provisioned-but-unused observability infrastructure.
--
-- Because timing is not rewarded, a SECURITY DEFINER close_session()
-- RPC is not needed today. The narrower, GRANT+RLS defence-in-depth
-- shape below produces the same guarantee at lower complexity:
--
-- (a) Column-level UPDATE grant restricted to ended_at
--     The GRANT layer rejects any UPDATE that touches anything other
--     than ended_at — started_at, user_id, device_kind, app_version,
--     created_at, and id become structurally immutable to a self-
--     update *before RLS even runs*.
--
-- (b) Tightened WITH CHECK
--     USING already pins the updatable row set to (caller's own AND
--     open). The hardened WITH CHECK enforces that the post-image is
--     a valid CLOSED session within a tight wall-clock window of now:
--       (1) is_self preserved — defence-in-depth against a future
--           grant change that re-exposes user_id;
--       (2) ended_at is NOT NULL — every UPDATE must close the
--           session, not produce some other "open + mutated" shape;
--       (3) ended_at <= now() + 1 minute — bounds client clock drift,
--           prevents "ended_at = year 3000" from manufacturing a
--           1000-year session duration if a future feature ever
--           reads session length.
--
-- Both layers must agree independently for an UPDATE to land. An
-- authenticated session UPDATE now means "close my open session with a
-- near-now timestamp," and nothing else. Any other shape is rejected
-- by exactly one of the two layers.
--
-- Service-role retains full table UPDATE via the existing
-- `20260427_grant_service_role_public.sql` schema-wide grant —
-- workers / reapers / future close_session() RPCs continue working
-- unchanged. INSERT path is untouched (the policy already pins
-- started_at to `now() - 1 minute .. now()`).
--
-- ---------------------------------------------------------------------------
-- ROLLBACK SCRIPT (run as postgres / supabase-admin)
-- ---------------------------------------------------------------------------
-- begin;
-- drop policy if exists sessions_update_self on public.sessions;
-- create policy sessions_update_self on public.sessions for update to authenticated
--   using (public.is_self(user_id) and ended_at is null)
--   with check (public.is_self(user_id));
-- revoke update (ended_at) on public.sessions from authenticated;
-- grant update on public.sessions to authenticated;
-- commit;
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- (a) Revoke table-level UPDATE; re-grant column-scoped on ended_at only.
-- ---------------------------------------------------------------------------
--
-- The cascade revokes per-column UPDATE on every column of
-- public.sessions (id, user_id, started_at, ended_at, device_kind,
-- app_version, created_at). The follow-up GRANT re-enables UPDATE on
-- ONLY ended_at — every other column is now sqlstate 42501 on a self-
-- update attempt at the GRANT layer, before RLS runs.
revoke update on public.sessions from authenticated;
grant update (ended_at) on public.sessions to authenticated;

-- ---------------------------------------------------------------------------
-- (b) Tighten sessions_update_self WITH CHECK.
-- ---------------------------------------------------------------------------
--
-- USING (unchanged): (is_self(user_id) AND ended_at IS NULL)
--   The caller can only touch their own open sessions. A non-owner
--   UPDATE is filtered out at the USING layer (rowcount=0, no error
--   returned to the caller — by design).
--
-- WITH CHECK (hardened): defence-in-depth on the post-image. See header.
drop policy if exists sessions_update_self on public.sessions;
create policy sessions_update_self on public.sessions
  for update to authenticated
  using (public.is_self(user_id) and ended_at is null)
  with check (
    public.is_self(user_id)
    and ended_at is not null
    and ended_at <= now() + interval '1 minute'
  );

commit;
