-- Migration: take5_sessions table + record_take5_shift SECURITY DEFINER RPC.
--
-- Backend for P4 (no-Drop-day Take 5 archive). ARCHIVE-ONLY launch — no
-- evergreen bank, no admin surface (deferred). The user-facing /take5
-- surface pulls up to 5 recent Drops the user has not yet stanced on,
-- newest first; the stack simply shows fewer than 5 cards when the
-- 7-day archive is thin.
--
-- Why a separate `take5_sessions` table at all when `opinion_shifts`
-- already records "user X stanced on topic Y":
--   * One session per ET day is a session-UI contract, not a shift
--     contract. `opinion_shifts` has no "which surface recorded this"
--     column and no per-ET-day cap. A dedicated session row carries
--     the ET date so the "5 cards per day" cap is a cheap COUNT.
--   * The eventual evergreen branch (deferred) needs a card_source
--     column; this table reserves the shape for that migration
--     without shipping it today.
--
-- RLS: SELECT own rows via is_self; writes ONLY through the
-- SECURITY DEFINER RPC `record_take5_shift`. No *_insert_self policy
-- (per CLAUDE.md "Data writes: RLS vs SECURITY DEFINER RPC") because
-- the write couples (opinion_shifts insert → trigger → streak credit)
-- with (take5_sessions insert under per-ET-day cap) — RLS `with check`
-- cannot express the cap, so the only safe writer is the RPC.
--
-- Streak credit path: the RPC calls the existing `record_opinion_shift`
-- RPC, which fires the `opinion_shifts_take5_after_insert` trigger
-- (migration 20261011000000) that advances the user's streak via
-- `increment_take5_progress(user_id, topic_id)`. This file adds NO new
-- streak code — the engine already does the right thing.
--
-- Prod max applied at author time: 20261104000000 (telegram cron).
-- This file sorts strictly after.
--
-- Up:
--   create table public.take5_sessions (…);
--   enable RLS; SELECT own; no app-role write policy.
--   SECURITY DEFINER RPC record_take5_shift(uuid, smallint, uuid).
-- Down (strict reversal order):
--   drop function if exists public.record_take5_shift(uuid, smallint, uuid);
--   drop table if exists public.take5_sessions;

begin;

create table public.take5_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  -- The Drop that was rendered in the Take 5 stack. Archive-only
  -- launch: this is always a news_topics row with is_drop=true.
  -- When the evergreen branch lands, that migration adds a nullable
  -- evergreen_id + card_source enum and relaxes this FK accordingly.
  topic_id uuid not null references public.news_topics(id) on delete cascade,
  -- The opinion_shifts row the RPC produced for this card.
  shift_id uuid not null references public.opinion_shifts(id) on delete cascade,
  -- ET date (America/New_York) the Take 5 card was stanced on. Used
  -- for the "5 per ET day" cap and for the operator-facing "when did
  -- the user complete Take 5 that day" readout. Computed server-side
  -- in the RPC; the client never sends it.
  et_day date not null,
  created_at timestamptz not null default now()
);

-- A user can stance on a given topic once via Take 5 — a stance flip
-- on the same card (same topic) by the same user is a no-op at this
-- layer (opinion_shifts still records the flip for the "latest stance"
-- read path, which is correct). This prevents gaming the daily cap by
-- re-tapping the same card.
create unique index take5_sessions_user_topic_uniq
  on public.take5_sessions (user_id, topic_id);

-- Serves the per-ET-day cap COUNT + the "today's take5 stack" read.
create index take5_sessions_user_et_day_idx
  on public.take5_sessions (user_id, et_day);

comment on table public.take5_sessions is
  'Per-stance log for the /take5 surface. One row per (user_id, topic_id). et_day is the America/New_York date of the stance, used for the 5-per-day cap. Writes only via record_take5_shift SECURITY DEFINER RPC.';

alter table public.take5_sessions enable row level security;

-- Users read their own session rows (debug UI / future "your stance
-- history" surface). No cross-user read.
create policy take5_sessions_select_own
  on public.take5_sessions
  for select to authenticated
  using (public.is_self(user_id));

-- No INSERT / UPDATE / DELETE policy — the RPC below is the only writer.

-- =========================================================================
-- SECURITY DEFINER RPC: record_take5_shift
-- =========================================================================
-- Records a user's Take 5 stance by:
--   (1) auth.uid() → user_id (server-derived)
--   (2) et_day = (now at America/New_York)::date
--   (3) per-ET-day cap check — raise 54000 if ≥ 5 cards today
--   (4) delegate to record_opinion_shift(topic_id, after_position,
--       client_key) which inserts public.opinion_shifts and fires
--       the Take 5 streak trigger
--   (5) link via public.take5_sessions (ON CONFLICT (user_id,
--       topic_id) DO NOTHING — idempotent on retry)
--
-- Called ONLY from the tRPC take5.recordShift mutation. The function
-- is granted to `authenticated` role; anon / public are revoked.

create or replace function public.record_take5_shift(
  p_topic_id       uuid,
  p_after_position smallint,
  p_client_key     uuid default null
)
returns table (
  shift_id    uuid,
  topic_id    uuid,
  et_day      date,
  cards_today int
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_et_day  date := (now() at time zone 'America/New_York')::date;
  v_shift   public.opinion_shifts;
  v_count   int;
begin
  -- (1) Caller must be authenticated. protectedProcedure in the tRPC
  -- layer refuses anon callers upstream, but defence-in-depth: a
  -- direct PostgREST hit without a bearer token lands here as a null
  -- auth.uid() and is rejected with the same sqlstate the existing
  -- record_opinion_shift uses.
  if v_user_id is null then
    raise exception 'not authenticated'
      using errcode = '28000';
  end if;

  -- (2) Serialize same-user Take 5 writers across the daily cap.
  -- Advisory lock keyed on (user_id, et_day) so concurrent sessions
  -- (web tab + PWA, retry burst) cannot each read a count < 5 and
  -- collectively exceed the cap. Transaction-scoped; auto-released
  -- on commit/rollback. Same pattern used in record_opinion_shift
  -- for the rolling-24h cap.
  perform pg_advisory_xact_lock(
    ('x' || substr(md5(v_user_id::text || v_et_day::text), 1, 16))::bit(64)::bigint
  );

  -- (3) Per-ET-day cap of 5 cards. Must check BEFORE delegating to
  -- record_opinion_shift so an over-cap tap does NOT credit the
  -- Take 5 streak trigger.
  select count(*)::int
    into v_count
    from public.take5_sessions
   where user_id = v_user_id and et_day = v_et_day;
  if v_count >= 5 then
    raise exception 'take5 daily cap reached: 5 cards per ET day'
      using errcode = '54000';  -- program_limit_exceeded
  end if;

  -- (4) Delegate to the existing opinion-shift writer. This fires
  -- the opinion_shifts_take5_after_insert trigger that advances the
  -- streak via increment_take5_progress. The nested RPC enforces
  -- its own rolling-24h cap + topic-exists + before_position
  -- snapshot — we inherit all of those guarantees here.
  --
  -- The call shape is positional. record_opinion_shift returns a
  -- public.opinion_shifts composite; we read .id into v_shift for
  -- the FK insert below.
  v_shift := public.record_opinion_shift(p_topic_id, p_after_position, p_client_key);

  -- (5) Link the shift to the Take 5 session row. UNIQUE (user_id,
  -- topic_id) prevents double-counting the same card across stance
  -- flips (opinion_shifts still records the flip; take5_sessions
  -- stays pinned to the FIRST session row for that topic). ON
  -- CONFLICT DO NOTHING is the idempotency path.
  insert into public.take5_sessions (user_id, topic_id, shift_id, et_day)
  values (v_user_id, p_topic_id, v_shift.id, v_et_day)
  on conflict (user_id, topic_id) do nothing;

  -- (6) Return the shift id, resolved et_day, and the post-insert
  -- cards_today count so the client can render the "N of 5" state
  -- without a round-trip. cards_today is read AFTER the insert so
  -- it reflects the just-added row on a first-time stance.
  return query
    select v_shift.id,
           p_topic_id,
           v_et_day,
           (select count(*)::int
              from public.take5_sessions
             where user_id = v_user_id and et_day = v_et_day);
end;
$$;

revoke all on function public.record_take5_shift(uuid, smallint, uuid) from public, anon;
grant execute on function public.record_take5_shift(uuid, smallint, uuid)
  to authenticated, service_role;

comment on function public.record_take5_shift(uuid, smallint, uuid) is
  'Server-authoritative writer for public.take5_sessions. Delegates '
  'the opinion_shift insert to record_opinion_shift (inheriting its '
  '24h cap, topic-exists check and before_position snapshot), then '
  'links the result to a take5_sessions row under a per-ET-day cap '
  'of 5 cards. Called by trpc.take5.recordShift. SECURITY DEFINER + '
  'search_path='''' + revoked-from-public, granted to authenticated.';

commit;
