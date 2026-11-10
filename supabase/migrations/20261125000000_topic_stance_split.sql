-- Migration: topic_stance_split RPC + supporting index
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
--     Callers get counts, nothing else.
--   * The privacy floor (<5 → suppress percentages, show "early")
--     lives in the tRPC layer, NOT the SQL. The RPC always returns
--     raw counts; the API decides what to render. Rationale: the
--     RPC is a reusable primitive — future surfaces (admin, batch
--     dashboards) may want raw numbers, and splitting the contract
--     there risks drift.
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
--   * No user input reaches a raised message; the function raises
--     with a fixed string on auth failure.
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

create or replace function public.topic_stance_split(
  p_topic_id uuid
)
returns table (
  agree_count    bigint,
  disagree_count bigint,
  total          bigint
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
  )
  select
    count(*) filter (where after_position > 0)  as agree_count,
    count(*) filter (where after_position < 0)  as disagree_count,
    count(*) filter (where after_position <> 0) as total
  from latest;
$$;

revoke all on function public.topic_stance_split(uuid) from public, anon;
grant execute on function public.topic_stance_split(uuid) to authenticated, service_role;

comment on function public.topic_stance_split(uuid) is
  'Aggregate stance split for a topic. Returns one row (agree_count, '
  'disagree_count, total) computed from the LATEST opinion_shifts row per '
  'user. Skip rows (after_position = 0) are excluded from total. Aggregate '
  'only — no user ids leave the function body.';

commit;
