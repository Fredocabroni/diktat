-- Migration: comments on news_topics (one level of replies).
--
-- Up:   create table public.comments; create table public.comment_likes;
--       enable RLS on both; add read-only SELECT policy on comments to
--       authenticated; create AFTER-trigger that maintains
--       comments.like_count; create SECURITY DEFINER RPCs
--       create_comment, delete_own_comment, toggle_comment_like; extend
--       public.reports.target_type CHECK to include 'comment' and
--       extend public.submit_report to resolve 'comment' targets.
-- Down: drop function public.toggle_comment_like(uuid);
--       drop function public.delete_own_comment(uuid);
--       drop function public.create_comment(uuid, uuid, text);
--       revert reports.submit_report to the pre-comment definition and
--       drop 'comment' from the target_type CHECK;
--       drop trigger comments_reply_recount_after;
--       drop function public.comments_reply_recount();
--       drop trigger comments_set_updated_at;
--       drop trigger comment_likes_recount_after;
--       drop function public.comment_likes_recount();
--       drop table public.comment_likes;
--       drop table public.comments;
--
-- Product rules this migration enforces in SQL (unbypassable):
--   * Comments live on a topic (news_topics). One level of replies:
--     the parent must be a top-level comment on the SAME topic. Both
--     checks happen inside create_comment; a direct PostgREST POST to
--     any *_insert_self policy is NOT possible — there is no such
--     policy (CLAUDE.md §"RLS vs SECURITY DEFINER RPC").
--   * To comment or reply, the user must have a locked stance on the
--     topic: the LATEST opinion_shifts row for (user_id, topic_id)
--     must have after_position <> 0. The stance ('agree' / 'disagree')
--     is snapshotted from THAT row at write time, server-derived, and
--     stored on the comment. The client never sends the stance.
--   * Body is 1..500 chars after trim (btrim). Longer or empty raises
--     22023.
--   * Soft delete by the author: delete_own_comment clears the body,
--     sets deleted_at; replies remain visible with their own bodies.
--   * Likes: one row per (comment_id, user_id). toggle_comment_like
--     inserts or deletes that row; the AFTER trigger keeps the
--     denormalised like_count on comments in sync. Likes on a soft-
--     deleted comment are a no-op (idempotency; nothing to like).
--
-- Author display is strictly the existing anonymous public.users.handle.
-- No email is read, snapshotted, or returned by any surface here.
--
-- Timestamp: 20261126000000 — strictly greater than the current prod
-- max (20261125000000 — topic_stance_split) so `supabase db push`
-- applies in-order.
--
-- Rollback (reference, not auto-run): see Down above.

begin;

-- ---------------------------------------------------------------------
-- 1) Tables.
-- ---------------------------------------------------------------------

create table public.comments (
  id          uuid primary key default gen_random_uuid(),
  topic_id    uuid not null references public.news_topics(id) on delete cascade,
  -- Nullable: NULL = top-level, otherwise references another row on
  -- the SAME topic that must itself be top-level (the one-level-reply
  -- rule). The RPC enforces both invariants at write time; the FK
  -- here guarantees referential integrity on the parent.
  parent_id   uuid references public.comments(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  -- Author handle snapshot. Denormalised at write time so a later
  -- handle change does not retroactively rewrite attribution on
  -- historical comments. citext matches public.users.handle.
  handle      extensions.citext not null,
  -- Server-derived from the LATEST opinion_shifts row at write time.
  -- Immutable after insert: a later change of mind does not retro-
  -- actively rewrite the stance printed next to the comment.
  stance      text not null check (stance in ('agree', 'disagree')),
  -- body is cleared on soft delete; NOT NULL so we always have a
  -- stable column (the UI renders "deleted" when deleted_at is set).
  -- Upper-bound CHECK is defense in depth: the create_comment RPC
  -- enforces `1..500 after btrim`, but a direct service_role insert
  -- (ops script, future migration backfill, Supabase Studio) must not
  -- be able to store unbounded text. Empty is valid — it's the soft-
  -- delete state — so the floor is RPC-only.
  body        text not null check (char_length(body) <= 500),
  deleted_at  timestamptz,
  -- Denormalised like count. Maintained by `comment_likes_recount`
  -- trigger. `select count(*) from comment_likes where comment_id = ?`
  -- would also work but costs an index scan per comment per read;
  -- denorm lets the list query sort `top` without a correlated
  -- subquery.
  like_count  integer not null default 0 check (like_count >= 0),
  -- Denormalised count of replies (top-level rows only; always 0 on a
  -- reply). Maintained by `comments_reply_recount`. Lets the list
  -- read show "N replies" without loading every reply row, so the
  -- inline-preview fetch can stay bounded at a few rows per parent.
  -- Soft-deleted replies still count (they render as "deleted").
  reply_count integer not null default 0 check (reply_count >= 0),
  created_at  timestamptz not null default now(),
  -- Mutable table (soft delete, like/reply recounts) → updated_at,
  -- stamped by the shared public.set_updated_at() trigger below.
  updated_at  timestamptz not null default now()
);

create trigger comments_set_updated_at
  before update on public.comments
  for each row execute function public.set_updated_at();

-- (topic_id, created_at desc) supports the `sort = 'new'` list.
create index comments_topic_created_idx
  on public.comments (topic_id, created_at desc);
-- (topic_id, like_count desc, created_at desc) supports `sort = 'top'`
-- with a stable tie-break by recency. Partial on `deleted_at is null`
-- so a highly-liked tombstone cannot out-rank live comments on the
-- top-sort surface. The router's `sort = 'top'` path matches this
-- predicate with `.is('deleted_at', null)` so the planner picks this
-- index.
create index comments_topic_like_count_idx
  on public.comments (topic_id, like_count desc, created_at desc)
  where deleted_at is null;
-- (parent_id, created_at) for the replies lookup — oldest first by
-- product convention (threaded context reads better chronologically).
create index comments_parent_created_idx
  on public.comments (parent_id, created_at asc)
  where parent_id is not null;
create index comments_user_idx on public.comments (user_id);

create table public.comment_likes (
  comment_id uuid not null references public.comments(id) on delete cascade,
  user_id    uuid not null references public.users(id)    on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

-- Reverse lookup for "has this user liked comment X?" in the list
-- RPC's liked_by_me subquery; PK already covers (comment_id, user_id)
-- but a leading-user-id index helps the common "my likes on this set
-- of comments" IN-list scan.
create index comment_likes_user_idx on public.comment_likes (user_id, comment_id);

-- ---------------------------------------------------------------------
-- 2) RLS. Reads only; all writes go through SECURITY DEFINER RPCs.
-- ---------------------------------------------------------------------

alter table public.comments        enable row level security;
alter table public.comment_likes   enable row level security;

-- Comments: any authenticated user can SELECT. Rows that are soft-
-- deleted (deleted_at is not null) are STILL visible as structural
-- placeholders — body is already cleared by the delete RPC, and the
-- client renders the "deleted" marker. The read RPC also returns
-- the empty body as empty string so a reader never sees raw deleted
-- content.
create policy comments_select_authenticated
  on public.comments for select
  to authenticated
  using (true);

-- comment_likes: SELECT is scoped to the caller's own rows ONLY. The
-- router computes `liked_by_me` by selecting comment_likes where
-- user_id = auth.uid() and comment_id IN (<page ids>) — this policy is
-- exactly the shape of that query. Never widen to `using (true)`: that
-- would expose every user's like graph to any authenticated caller.
create policy comment_likes_select_own
  on public.comment_likes for select
  to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- 3) like_count trigger.
-- ---------------------------------------------------------------------

create function public.comment_likes_recount()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.comments
       set like_count = like_count + 1
     where id = new.comment_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.comments
       set like_count = greatest(like_count - 1, 0)
     where id = old.comment_id;
    return old;
  end if;
  return null;
end;
$$;

create trigger comment_likes_recount_after
  after insert or delete on public.comment_likes
  for each row execute function public.comment_likes_recount();

-- reply_count trigger. Fires only for reply rows (parent_id not null).
-- A hard delete of a reply (e.g. account deletion cascade) decrements
-- its parent; a parent's own cascade delete takes its replies with it.
create function public.comments_reply_recount()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.parent_id is not null then
      update public.comments
         set reply_count = reply_count + 1
       where id = new.parent_id;
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if old.parent_id is not null then
      update public.comments
         set reply_count = greatest(reply_count - 1, 0)
       where id = old.parent_id;
    end if;
    return old;
  end if;
  return null;
end;
$$;

create trigger comments_reply_recount_after
  after insert or delete on public.comments
  for each row execute function public.comments_reply_recount();

-- ---------------------------------------------------------------------
-- 4) RPC: create_comment.
--
-- SQLSTATE contract (so the tRPC layer can map cleanly):
--   28000 - not authenticated
--   22023 - body length out of range (1..500 after trim)
--   54000 - rolling-24h cap hit (60 comments / user / 24h)
--   P0002 - topic not found
--   P0001 'comments: no_locked_stance'      - user has no locked stance
--   P0001 'comments: parent_not_found'      - parent_id does not exist
--   P0001 'comments: reply_depth_exceeded'  - parent is itself a reply
--   P0001 'comments: parent_topic_mismatch' - parent is on a different topic
--
-- The 60/24h cap is enforced INSIDE the RPC with a transaction-scoped
-- advisory lock keyed on hash(user_id). The lock serializes parallel
-- bursts per-user so the COUNT + INSERT run atomically — the rate
-- limiter at the tRPC layer (mutationLimit 5/min) is the bursty
-- guard; this is the daily ceiling that cannot be bypassed via
-- direct PostgREST POSTs. Same pattern as record_opinion_shift
-- (migration 20261010000000).
-- ---------------------------------------------------------------------

create function public.create_comment(
  p_topic_id  uuid,
  p_parent_id uuid,
  p_body      text
)
returns public.comments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id        uuid := auth.uid();
  v_body           text;
  v_handle         extensions.citext;
  v_after_position smallint;
  v_stance         text;
  v_parent_topic   uuid;
  v_parent_parent  uuid;
  v_topic_exists   boolean;
  v_recent_count   integer;
  v_row            public.comments;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- Body trim + length cap. Enforced in SQL so a direct PostgREST POST
  -- to this RPC (or the service role) cannot bypass the product rule.
  v_body := btrim(coalesce(p_body, ''));
  if char_length(v_body) < 1 or char_length(v_body) > 500 then
    raise exception 'comments: body length out of range (1..500)'
      using errcode = '22023';
  end if;

  -- Serialize parallel bursts per-user. hashtextextended(user_id) folds
  -- the uuid into a bigint keyspace so pg_advisory_xact_lock takes a
  -- single lock parameter. The lock is transaction-scoped: released
  -- automatically on commit/rollback.
  perform pg_advisory_xact_lock(
    hashtextextended(v_user_id::text, 42)
  );

  -- 60 / 24h rolling cap. Counts non-deleted AND deleted rows (a
  -- deleted row still cost a write). Enforced here with the lock
  -- held so a parallel burst cannot slip past the COUNT.
  select count(*) into v_recent_count
    from public.comments
   where user_id = v_user_id
     and created_at > now() - interval '24 hours';
  if v_recent_count >= 60 then
    raise exception 'comments: rate limit exceeded (60 / 24h)'
      using errcode = '54000';
  end if;

  -- Topic existence. pk-indexed so this is a single probe.
  select exists (select 1 from public.news_topics where id = p_topic_id)
    into v_topic_exists;
  if not v_topic_exists then
    raise exception 'topic not found' using errcode = 'P0002';
  end if;

  -- Locked stance gate. Read the LATEST opinion_shifts row for this
  -- (user, topic). Non-zero after_position is the "locked stance"
  -- invariant — matches the feed rule that a 0-value row counts as a
  -- skip and is not a stance. Composite index
  -- `opinion_shifts_user_topic_created_idx` (migration
  -- 20260420090011) makes this a single index seek.
  select after_position into v_after_position
    from public.opinion_shifts
   where user_id  = v_user_id
     and topic_id = p_topic_id
   order by created_at desc
   limit 1;
  if v_after_position is null or v_after_position = 0 then
    raise exception 'comments: no_locked_stance' using errcode = 'P0001';
  end if;
  v_stance := case when v_after_position > 0 then 'agree' else 'disagree' end;

  -- Parent-reply invariants: exists, same topic, not itself a reply.
  if p_parent_id is not null then
    select topic_id, parent_id
      into v_parent_topic, v_parent_parent
      from public.comments
     where id = p_parent_id;
    if v_parent_topic is null then
      raise exception 'comments: parent_not_found' using errcode = 'P0001';
    end if;
    if v_parent_topic <> p_topic_id then
      raise exception 'comments: parent_topic_mismatch' using errcode = 'P0001';
    end if;
    if v_parent_parent is not null then
      raise exception 'comments: reply_depth_exceeded' using errcode = 'P0001';
    end if;
  end if;

  -- Snapshot the author's current handle. A later /settings handle
  -- change does not retroactively rewrite attribution. NEVER touch
  -- auth.users.email — product rule.
  select u.handle into v_handle
    from public.users u where u.id = v_user_id;
  if v_handle is null then
    raise exception 'user profile missing' using errcode = 'P0001';
  end if;

  insert into public.comments (
    topic_id, parent_id, user_id, handle, stance, body
  )
  values (
    p_topic_id, p_parent_id, v_user_id, v_handle, v_stance, v_body
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------
-- 5) RPC: delete_own_comment.
--
-- Soft delete: clears body, stamps deleted_at, leaves the row so
-- replies remain contextually anchored. Author-only. SQLSTATE:
--   28000 - not authenticated
--   P0001 'comments: not_owner'   - caller is not the author
--   P0002 - comment not found (or already deleted at this shape;
--           we treat already-deleted as a no-op success below)
-- ---------------------------------------------------------------------

create function public.delete_own_comment(
  p_comment_id uuid
)
returns public.comments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_owner   uuid;
  v_row     public.comments;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select user_id into v_owner
    from public.comments
   where id = p_comment_id;
  if v_owner is null then
    raise exception 'comment not found' using errcode = 'P0002';
  end if;
  if v_owner <> v_user_id then
    raise exception 'comments: not_owner' using errcode = 'P0001';
  end if;

  update public.comments
     set body = '',
         deleted_at = coalesce(deleted_at, now())
   where id = p_comment_id
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------
-- 6) RPC: toggle_comment_like.
--
-- Insert-or-delete the (comment_id, user_id) row. Returns the new
-- {liked, like_count} state. Likes on a soft-deleted comment are a
-- no-op (idempotent, no state change). SQLSTATE:
--   28000 - not authenticated
--   P0002 - comment not found
-- ---------------------------------------------------------------------

create function public.toggle_comment_like(
  p_comment_id uuid
)
returns table (
  liked      boolean,
  like_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id    uuid := auth.uid();
  v_deleted_at timestamptz;
  v_existing   uuid;
  v_count      integer;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- Serialize parallel toggles from the SAME user on the SAME comment.
  -- Under read-committed, two concurrent calls both read v_existing as
  -- null and race into INSERT — one wins, the other raises 23505 on
  -- the (comment_id, user_id) PK. The advisory lock is per-tuple and
  -- transaction-scoped, released on commit/rollback. Matches the
  -- create_comment per-user lock idiom.
  perform pg_advisory_xact_lock(
    hashtextextended(p_comment_id::text || ':' || v_user_id::text, 42)
  );

  select deleted_at into v_deleted_at
    from public.comments
   where id = p_comment_id;
  -- `found` is set by the SELECT; use it to distinguish missing row
  -- from "row present, deleted_at null".
  if not found then
    raise exception 'comment not found' using errcode = 'P0002';
  end if;
  if v_deleted_at is not null then
    -- No-op; return the current state without touching the join table.
    select c.like_count into v_count
      from public.comments c where c.id = p_comment_id;
    liked := false;
    like_count := v_count;
    return next;
    return;
  end if;

  select user_id into v_existing
    from public.comment_likes
   where comment_id = p_comment_id and user_id = v_user_id;

  if v_existing is null then
    insert into public.comment_likes (comment_id, user_id)
      values (p_comment_id, v_user_id);
    liked := true;
  else
    delete from public.comment_likes
      where comment_id = p_comment_id and user_id = v_user_id;
    liked := false;
  end if;

  -- Re-read the count AFTER the trigger has fired.
  select c.like_count into v_count
    from public.comments c where c.id = p_comment_id;
  like_count := v_count;
  return next;
end;
$$;

-- ---------------------------------------------------------------------
-- 7) Grants.
-- ---------------------------------------------------------------------

revoke all on function public.create_comment(uuid, uuid, text)        from public, anon;
revoke all on function public.delete_own_comment(uuid)                from public, anon;
revoke all on function public.toggle_comment_like(uuid)               from public, anon;
revoke all on function public.comment_likes_recount()                 from public, anon;
revoke all on function public.comments_reply_recount()                from public, anon;

grant execute on function public.create_comment(uuid, uuid, text)     to authenticated, service_role;
grant execute on function public.delete_own_comment(uuid)             to authenticated, service_role;
grant execute on function public.toggle_comment_like(uuid)            to authenticated, service_role;
-- comment_likes_recount is only called by the trigger; no direct caller.

-- ---------------------------------------------------------------------
-- 8) Reports: extend target_type to accept 'comment'.
--
-- The existing CHECK constraint on public.reports.target_type is
-- replaced to add 'comment'. public.submit_report is rewritten with
-- the same signature + behaviour plus a new elsif branch resolving
-- 'comment' → public.comments.
--
-- This is additive and backwards-compatible: existing target_type
-- values ('debate_arg', 'drop', 'user') remain valid; existing
-- callers see no change.
-- ---------------------------------------------------------------------

alter table public.reports drop constraint reports_target_type_check;
alter table public.reports add constraint reports_target_type_check
  check (target_type in ('debate_arg', 'drop', 'user', 'comment'));

create or replace function public.submit_report(
  p_target_type text,
  p_target_id   uuid,
  p_reason      text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id       uuid := auth.uid();
  v_age_verified  timestamptz;
  v_recent_count  int;
  v_target_ok     boolean;
  v_new_id        uuid;
  v_existing_id   uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  p_reason := nullif(btrim(p_reason), '');
  if p_reason is null or char_length(p_reason) > 2000 then
    raise exception 'reports: reason length out of range (1..2000)'
      using errcode = '22023';
  end if;

  if p_target_type not in ('debate_arg', 'drop', 'user', 'comment') then
    raise exception 'reports: unknown target_type'
      using errcode = '22023';
  end if;

  select age_verified_at into v_age_verified
    from public.users where id = v_user_id;
  if v_age_verified is null then
    raise exception 'reports: age_not_verified'
      using errcode = 'P0001';
  end if;

  if p_target_type = 'debate_arg' then
    select exists (select 1 from public.debate_arguments where id = p_target_id)
      into v_target_ok;
  elsif p_target_type = 'drop' then
    select exists (select 1 from public.news_topics where id = p_target_id)
      into v_target_ok;
  elsif p_target_type = 'user' then
    select exists (select 1 from public.users where id = p_target_id)
      into v_target_ok;
  elsif p_target_type = 'comment' then
    select exists (select 1 from public.comments where id = p_target_id)
      into v_target_ok;
  else
    v_target_ok := false;
  end if;
  if not v_target_ok then
    raise exception 'reports: target_not_found'
      using errcode = 'P0001';
  end if;

  select count(*) into v_recent_count
    from public.reports
    where reporter_user_id = v_user_id
      and created_at > now() - interval '1 hour';
  if v_recent_count >= 10 then
    raise exception 'reports: rate_limited'
      using errcode = 'P0001';
  end if;

  insert into public.reports (reporter_user_id, target_type, target_id, reason)
  values (v_user_id, p_target_type, p_target_id, p_reason)
  on conflict (reporter_user_id, target_type, target_id)
    where reporter_user_id is not null
    do nothing
  returning id into v_new_id;

  if v_new_id is not null then
    return jsonb_build_object('outcome', 'submitted', 'id', v_new_id);
  end if;

  select id into v_existing_id
    from public.reports
   where reporter_user_id = v_user_id
     and target_type      = p_target_type
     and target_id        = p_target_id;
  return jsonb_build_object('outcome', 'already_reported', 'id', v_existing_id);
end;
$$;

comment on function public.create_comment(uuid, uuid, text) is
  'Author a comment or one-level reply on a news_topic. Enforces: '
  'authenticated caller, body 1..500 after trim, topic exists, caller '
  'has a locked stance (latest opinion_shifts row <> 0; stance snapshot '
  'is server-derived), parent is a top-level comment on the same topic. '
  'Author handle is snapshotted at write time; email is never read.';
comment on function public.delete_own_comment(uuid) is
  'Soft-delete a comment the caller authored: clear body, stamp '
  'deleted_at, leave the row so replies remain contextually anchored.';
comment on function public.toggle_comment_like(uuid) is
  'Toggle one like per (comment, user). Likes on a soft-deleted '
  'comment are a no-op. Returns (liked, like_count).';

commit;
