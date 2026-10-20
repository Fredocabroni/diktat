-- Migration: record_take5_shift advisory-lock key separator.
--
-- Follow-up from the security-reviewer LOW on PR #272. The original
-- function (migration 20261105000000) keyed the per-ET-day advisory
-- lock on `md5(user_id::text || et_day::text)` without a separator
-- between the two concatenated values. The practical collision risk
-- is already negligible (16 hex chars → 64-bit space), and the worst
-- consequence of a collision is transient over-serialisation of two
-- distinct users' writes — not a correctness defect. This migration
-- replaces the function body with a `':'` separator between the two
-- components so the concatenation is unambiguous and the pattern
-- matches the "md5(parts with separators)" shape used elsewhere.
--
-- The rest of the function body is byte-identical to migration
-- 20261105000000; only line (2) changes. Signature, parameters,
-- return shape, GRANT/REVOKE, and the function comment are unchanged.
--
-- Up:
--   create or replace function public.record_take5_shift(...)
--     with the separator fix.
--
-- Down (reversal; not expected but documented):
--   `create or replace function public.record_take5_shift(...)` with
--   the previous no-separator form from migration 20261105000000.
--
-- No GRANT/REVOKE changes: `create or replace function` preserves the
-- existing privileges on the signature `(uuid, smallint, uuid)`.

begin;

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
#variable_conflict use_column
declare
  v_user_id uuid := auth.uid();
  v_et_day  date := (now() at time zone 'America/New_York')::date;
  v_shift   public.opinion_shifts;
  v_count   int;
begin
  if v_user_id is null then
    raise exception 'not authenticated'
      using errcode = '28000';
  end if;

  -- (2) Serialize same-user Take 5 writers across the daily cap.
  -- Advisory lock keyed on (user_id, et_day). The `':'` separator
  -- between the two components makes the concatenation unambiguous
  -- (follow-up from PR #272 security-reviewer LOW). The rest of the
  -- shape is identical to the migration-20261105000000 body.
  perform pg_advisory_xact_lock(
    ('x' || substr(md5(v_user_id::text || ':' || v_et_day::text), 1, 16))::bit(64)::bigint
  );

  select count(*)::int
    into v_count
    from public.take5_sessions t
   where t.user_id = v_user_id and t.et_day = v_et_day;
  if v_count >= 5 then
    raise exception 'take5 daily cap reached: 5 cards per ET day'
      using errcode = '54000';
  end if;

  v_shift := public.record_opinion_shift(p_topic_id, p_after_position, p_client_key);

  insert into public.take5_sessions (user_id, topic_id, shift_id, et_day)
  values (v_user_id, p_topic_id, v_shift.id, v_et_day)
  on conflict (user_id, topic_id) do nothing;

  return query
    select v_shift.id,
           p_topic_id,
           v_et_day,
           (select count(*)::int
              from public.take5_sessions t
             where t.user_id = v_user_id and t.et_day = v_et_day);
end;
$$;

commit;
