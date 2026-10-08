-- SECURITY DEFINER RPC to replace direct `opinion_shifts_insert_self` writes
-- (#145). Writes are currently gated only by RLS `with check (is_self(user_id))`,
-- which cannot cap per-day shift volume, cannot server-snapshot `ap_at_shift_time`,
-- and cannot derive `before_position` from the user's prior shift. Any
-- authenticated bearer can POST straight to PostgREST and farm the Take 5
-- `opinion_shifts_credit_take5` after-insert trigger for streak credit without
-- ever touching the UI.
--
-- Shape mirrors `cast_debate_vote` (#114, migration 20260730120000) and
-- `place_prediction` (H3, migration 20260729120000):
--
--   * `auth.uid()` is derived server-side; no `p_user_id` input.
--   * `before_position` is server-snapshotted from the caller's latest shift
--     on the same topic (0 when none — "first-time voter on this topic"
--     default, matches the pre-RPC resolver behavior in apps/api/src/routers/
--     feed.ts:118-119 so existing clients see no behavior change).
--   * Rolling-24h cap: ≥50 shifts in the preceding 24h raises; 50 is generous
--     for honest change-of-mind across today's Drop + a tail of recent Drops,
--     tight enough to make streak-farming uneconomical. The cap is a defensive
--     ceiling; the per-tap `client_key` idempotency index remains the primary
--     dedup for honest retry.
--   * ON CONFLICT (user_id, client_key) WHERE client_key IS NOT NULL DO NOTHING
--     is a true no-op on conflict: the AFTER INSERT trigger does NOT fire on
--     the conflict path, so an idempotent retry cannot double-credit Take 5.
--     A follow-up SELECT returns the pre-existing row — same wire shape as
--     the first-time insert.
--   * NULL `p_client_key` writes a fresh row every call (NULL != NULL in the
--     partial unique index, so no conflict can fire). This is the legacy-PWA
--     path; the rolling-24h cap is the only guard there, which is acceptable
--     for the rollout window where stale clients may still omit the key.
--
-- PR A is additive. The `opinion_shifts_insert_self` policy is NOT dropped in
-- this migration; a follow-up PR C drops it after PR B swaps the resolver to
-- route exclusively through this RPC.
--
-- Timestamp: 20261010000000 — strictly greater than the current prod max
-- (20261001070000) so `supabase db push` applies in-order.
--
-- Rollback (reference, not auto-run):
--   drop function if exists public.record_opinion_shift(uuid, smallint, uuid);

begin;

create or replace function public.record_opinion_shift(
  p_topic_id       uuid,
  p_after_position smallint,
  p_client_key     uuid default null
)
returns public.opinion_shifts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id          uuid := auth.uid();
  v_before_position  smallint;
  v_shifts_24h       integer;
  v_row              public.opinion_shifts;
begin
  -- (1) Caller must be a real authenticated user. SECURITY DEFINER elevates
  -- role for execution; it does NOT elevate the JWT claims — auth.uid() still
  -- returns the caller's `sub`.
  if v_user_id is null then
    raise exception 'not authenticated'
      using errcode = '28000';
  end if;

  -- (2) Mirror the CHECK constraint on opinion_shifts.after_position so a bad
  -- input raises here with a clean message instead of a generic 23514.
  if p_after_position is null or p_after_position < -2 or p_after_position > 2 then
    raise exception 'after_position out of range (-2..2)'
      using errcode = '22023';
  end if;

  -- (3) Idempotency fast-path. If the caller sent a client_key AND a prior
  -- (user_id, client_key) row exists, return it immediately — before the
  -- rolling-24h cap check below. The partial unique index
  -- `opinion_shifts_user_client_key_uniq` serves this lookup.
  --
  -- Why this comes BEFORE the cap: the client_key is an idempotency token.
  -- An honest retry (the client's request was recorded but the ack was lost
  -- on the network) must return the recorded row no matter how many shifts
  -- the user has in the window. Without this fast-path, a user who just
  -- crossed 50 shifts with their 50th tap would get 54000 on the retry of
  -- that same 50th tap — the row IS recorded, but the response says "rate
  -- limit exceeded." The idempotency contract (migration 20260930000000)
  -- wins over the cap when the key proves the request is a retry.
  -- #179 schema-reviewer F-RATELIMIT-IDEM.
  if p_client_key is not null then
    select *
      into v_row
      from public.opinion_shifts
     where user_id = v_user_id
       and client_key = p_client_key;
    if found then
      return v_row;
    end if;
  end if;

  -- (4) Topic existence — PERFORM ... FOR SHARE pins the topic row through
  -- the INSERT below, so a concurrent delete between the check and the
  -- insert cannot leak a raw 23503 (FK violation) with the constraint name.
  -- The FOR SHARE lock is released at commit; it does not block other
  -- readers, only concurrent exclusive locks (e.g. DELETE / UPDATE on this
  -- row). Matches place_prediction's posture. #179 security-reviewer F3.
  perform 1 from public.news_topics where id = p_topic_id for share;
  if not found then
    raise exception 'topic not found'
      using errcode = 'P0002';
  end if;

  -- (5) Serialize concurrent writers for THIS user. Without the advisory
  -- lock, N parallel sessions can all read a count < 50 before any lands
  -- the first INSERT, collectively passing the gate at 50+N. The lock
  -- key is derived from the user_id uuid so it is unique per user; it is
  -- transaction-scoped and auto-released on commit/rollback; it serializes
  -- writes on the same user without touching unrelated users. #179
  -- security-reviewer F1.
  perform pg_advisory_xact_lock(
    ('x' || substr(md5(v_user_id::text), 1, 16))::bit(64)::bigint
  );

  -- (6) Rolling-24h cap. 50 shifts/user/24h is far above any honest
  -- change-of-mind workload (one Drop/day + a tail of past Drops ≈ 5-10
  -- shifts) and well below the velocity needed to farm Take 5 streak credit.
  -- Uses the composite index on (user_id, topic_id, created_at DESC); the
  -- same index serves the before_position snapshot below. The advisory lock
  -- above makes this COUNT→INSERT pair atomic per user.
  select count(*)
    into v_shifts_24h
    from public.opinion_shifts
   where user_id = v_user_id
     and created_at > now() - interval '24 hours';
  if v_shifts_24h >= 50 then
    raise exception 'rate limit exceeded: 50 opinion_shifts per 24h'
      using errcode = '54000';  -- program_limit_exceeded
  end if;

  -- (7) Server-authoritative before_position. The resolver no longer accepts
  -- a client-sent value (post-#158); this RPC completes that defense in depth
  -- by making the snapshot unforgeable even on the direct-PostgREST path once
  -- PR C drops the client INSERT policy.
  select after_position
    into v_before_position
    from public.opinion_shifts
   where user_id = v_user_id
     and topic_id = p_topic_id
   order by created_at desc
   limit 1;
  v_before_position := coalesce(v_before_position, 0::smallint);

  -- (8) Idempotent insert. ON CONFLICT ... DO NOTHING fires only when the
  -- partial unique index `opinion_shifts_user_client_key_uniq` matches
  -- (requires p_client_key IS NOT NULL + a prior row with that pair). On a
  -- NULL p_client_key the index predicate `client_key is not null` is false
  -- for the candidate row, so no conflict can fire and INSERT always proceeds.
  -- The ON CONFLICT path is now defence-in-depth against a race between the
  -- step-(3) idempotency fast-path and a concurrent writer with the same
  -- client_key — the step-(5) advisory lock serializes same-user writers,
  -- so the race is only reachable across advisory-lock holders (none today).
  insert into public.opinion_shifts
    (user_id, topic_id, before_position, after_position, client_key)
  values
    (v_user_id, p_topic_id, v_before_position, p_after_position, p_client_key)
  on conflict (user_id, client_key) where client_key is not null do nothing
  returning * into v_row;

  -- (9) If RETURNING produced nothing, the ON CONFLICT path NO-OPed (the AFTER
  -- INSERT trigger did NOT fire, no double-credit) — fetch the pre-existing
  -- row. The SELECT is scoped to (user_id, client_key); the user_id filter
  -- prevents a hypothetical cross-user uuid collision from leaking another
  -- caller's row via the client-supplied key (belt-and-suspenders — client_key
  -- is a v4 uuid in practice, so collisions are negligible, but the extra
  -- predicate costs nothing and matches the resolver's existing posture).
  if v_row.id is null then
    select *
      into v_row
      from public.opinion_shifts
     where user_id = v_user_id
       and client_key = p_client_key
     limit 1;
    if v_row.id is null then
      -- Unreachable: ON CONFLICT fired but the matching row vanished between
      -- the INSERT and the SELECT. Surface as a controlled error rather than
      -- returning a null composite the resolver would struggle to parse.
      raise exception 'opinion_shift conflict unreachable: no row found for client_key'
        using errcode = 'P0001';
    end if;
  end if;

  return v_row;
end;
$$;

-- Lock the function surface down. SECURITY DEFINER means the function body
-- runs with the owner's privileges; grants on the function itself gate who
-- can INVOKE it. anon has no business recording opinion_shifts; `public` is
-- the catch-all pseudo-role whose default EXECUTE on new functions we drop
-- deliberately (follows the posture of place_prediction + cast_debate_vote).
revoke all on function public.record_opinion_shift(uuid, smallint, uuid) from public, anon;
grant execute on function public.record_opinion_shift(uuid, smallint, uuid)
  to authenticated, service_role;

comment on function public.record_opinion_shift(uuid, smallint, uuid) is
  'Server-authoritative writer for public.opinion_shifts. Snapshots '
  'before_position from the caller''s latest shift; enforces a rolling-24h '
  'cap of 50 shifts/user; dedup via (user_id, client_key) partial index with '
  'ON CONFLICT DO NOTHING so the Take 5 after-insert trigger cannot be '
  'double-credited by idempotent retry. SECURITY DEFINER wrapper that '
  'replaces direct PostgREST writes against the opinion_shifts_insert_self '
  'policy — see issue #145. The policy drop ships in a separate PR after the '
  'resolver swap lands and is deployed.';

commit;
