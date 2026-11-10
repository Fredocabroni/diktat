-- Migration: topic_stance_split RPC + supporting index
--
-- Up:   create (topic_id, user_id, created_at desc) index on
--       public.opinion_shifts; create SECURITY DEFINER function
--       public.topic_stance_split(uuid) returning (agree_count,
--       disagree_count, total, early) with an in-SQL privacy floor
--       that returns null counts + early=true when total < 5.
-- Down: drop function public.topic_stance_split(uuid); drop index
--       public.opinion_shifts_topic_user_created_idx.
--
-- Post-vote split on Drop / feed topic cards. After a user taps
-- Agree/Disagree, the UI reads an aggregate split of this topic's
-- stances (agree / disagree / total) so the vote "goes somewhere
-- visible" — the earlier state saved the row and highlighted the
-- button but showed nothing else, which read as broken.
--
-- Contract:
--   * Latest-stance-per-user: a user who flipped agree→disagree
--     counts once, as disagree (their current stance). Earlier
--     rows for the same (user_id, topic_id) are ignored. Skip
--     rows (after_position = 0) are counted into neither side
--     and excluded from `total`.
--   * Aggregate only. No user ids ever leave the function body.
--   * Privacy floor baked into the SQL. When fewer than 5 users
--     have a non-skip stance on the topic, all three counts come
--     back as NULL and `early = true`. At >= 5 counts come back as
--     real bigints and `early = false`. This is defense-in-depth
--     against a direct `POST /rest/v1/rpc/topic_stance_split` by
--     any authenticated JWT — the tRPC floor alone leaves raw
--     counts available at the PostgREST surface, enabling single-
--     user attribution by differencing before/after a target
--     votes. Security review on #308 flagged this as LOW; hardened
--     here. (The tRPC handler keeps its own <5 check as belt-and-
--     braces.)
--
-- Index: the existing composite index
--   (user_id, topic_id, created_at desc)  -- 20260420090011
-- is user-first and wrong-leaf for a topic-wide scan. Add
--   (topic_id, user_id, created_at desc)
-- so the DISTINCT ON (user_id) over WHERE topic_id = ? can walk
-- the index in order and never materialize the full shift history.
--
-- Security:
--   * `security definer` + `set search_path = ''`.
--   * `revoke all from public, anon`; `grant execute to authenticated,
--     service_role`. Anonymous visitors cannot read split rows.
--   * No user input reaches a raised message.
--
-- Timestamp: 20261125000000 — strictly greater than the current
-- prod max (20261124000000) so `supabase db push` applies in-order.
--
-- Rollback (reference, not auto-run):
--   drop function if exists public.topic_stance_split(uuid);
--   drop index  if exists public.opinion_shifts_topic_user_created_idx;

begin;

create index if not exists opinion_shifts_topic_user_created_idx
  on public.opinion_shifts (topic_id, user_id, created_at desc);

-- The return shape changed from (bigint, bigint, bigint) to
-- (bigint, bigint, bigint, boolean), so `create or replace` is
-- insufficient — Postgres refuses a return-type change on replace.
-- Drop first; the function is new in this PR and has not been
-- applied to prod, so no live client can call it mid-migration.
drop function if exists public.topic_stance_split(uuid);

create function public.topic_stance_split(
  p_topic_id uuid
)
returns table (
  agree_count    bigint,
  disagree_count bigint,
  total          bigint,
  early          boolean
)
language sql
security definer
stable
set search_path = ''
as $$
  with latest as (
    select distinct on (s.user_id)
      s.user_id,
      s.after_position
    from public.opinion_shifts s
    where s.topic_id = p_topic_id
    order by s.user_id, s.created_at desc
  ),
  counts as (
    select
      count(*) filter (where after_position > 0)  as agree_count,
      count(*) filter (where after_position < 0)  as disagree_count,
      count(*) filter (where after_position <> 0) as total
    from latest
  )
  select
    case when total < 5 then null::bigint else agree_count    end as agree_count,
    case when total < 5 then null::bigint else disagree_count end as disagree_count,
    case when total < 5 then null::bigint else total          end as total,
    (total < 5)                                                  as early
  from counts;
$$;

revoke all on function public.topic_stance_split(uuid) from public, anon;
grant execute on function public.topic_stance_split(uuid) to authenticated, service_role;

comment on function public.topic_stance_split(uuid) is
  'Aggregate stance split for a topic with an in-SQL privacy floor. '
  'Returns one row (agree_count, disagree_count, total, early) computed '
  'from the LATEST opinion_shifts row per user. Skip rows '
  '(after_position = 0) are excluded from total. When total < 5 all '
  'three counts are NULL and early = true so direct PostgREST callers '
  'cannot read small-N counts. Aggregate only — no user ids leave the '
  'function body.';

commit;
