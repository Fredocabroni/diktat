-- Migration: comment_safety_precheck
--
-- Adds a small pre-write safety filter to public.create_comment:
--
--   1. New table public.comment_block_patterns — operator-seeded
--      regexes (slurs + doxxing shapes). The slur list is seeded by
--      operators, NEVER checked into this repo; the migration seeds
--      only the shape-based doxxing patterns (SSN, phone-number,
--      credit-card-shaped runs) that don't need an ugly wordlist.
--   2. New helper public._comment_body_blocked(text) returns text —
--      returns the blocking reason label (e.g. 'doxxing',
--      'operator_wordlist') or null.
--   3. public.create_comment is CREATEd OR REPLACEd to call the
--      helper RIGHT AFTER the length check; a non-null label raises
--      a new SQLSTATE (23514 'comments: body_blocked_<label>') so
--      the tRPC layer can surface a generic rejection without
--      disclosing which pattern matched.
--
-- AI safety hook (optional): this migration ships the SYNC filter
-- only. An async AI review path (behind an off-by-default worker env
-- flag COMMENT_AI_SAFETY_ENABLED) is a follow-up PR — the stub lives
-- in apps/workers but the DB schema has no coupling to it. Keeping
-- them in separate PRs means a wordlist change doesn't need an AI
-- credit review, and vice versa.
--
-- Access posture:
--   * comment_block_patterns is seeded / updated by service_role only;
--     authenticated has no SELECT (the patterns don't need to leak).
--   * _comment_body_blocked is SECURITY DEFINER + search_path=''.
--
-- Down: drop the helper, drop the table, restore the 20261126000000
-- create_comment body (the block-check call is the only change).

begin;

create table public.comment_block_patterns (
  id              uuid primary key default gen_random_uuid(),
  pattern         text not null,
  reason_label    text not null check (reason_label ~ '^[a-z][a-z_]{0,31}$'),
  enabled         boolean not null default true,
  created_at      timestamptz not null default now()
);

create index comment_block_patterns_enabled_idx
  on public.comment_block_patterns (enabled)
  where enabled is true;

-- RLS: deny by default. Writes via service_role only; the create_comment
-- RPC reads patterns under its own SECURITY DEFINER context and does
-- not need a client-visible policy.
alter table public.comment_block_patterns enable row level security;

revoke all on table public.comment_block_patterns from public, anon, authenticated;
grant select, insert, update, delete on table public.comment_block_patterns to service_role;

-- Seed: shape-based doxxing patterns. Deliberately NO slur list in
-- the repo — operators seed that separately via a secret-manager
-- population script (see TODO in CLAUDE.md).
--
-- Patterns:
--   * SSN-shaped: three-digit / two-digit / four-digit groups joined
--     by '-' or spaces. Matches 123-45-6789 and 123 45 6789.
--   * US phone: optional +1 or (XXX), then 7 digits with separators.
--     Tolerant enough to catch 555-123-4567 and (555) 123 4567 but
--     strict enough that '42, 1234, and 5000' doesn't trip.
--   * 15-19 digit runs separated by spaces or dashes — credit-card
--     shapes. A full card number through Luhn is beyond regex, but
--     the shape alone is already a doxxing-grade signal.
insert into public.comment_block_patterns (pattern, reason_label) values
  ('(^|[^0-9])\d{3}[\s-]\d{2}[\s-]\d{4}([^0-9]|$)',                    'doxxing_ssn'),
  ('(^|[^0-9])(\+?1[\s-]?)?(\(\d{3}\)|\d{3})[\s-]\d{3}[\s-]\d{4}([^0-9]|$)', 'doxxing_phone'),
  ('(^|[^0-9])(\d[\s-]?){15,19}([^0-9]|$)',                             'doxxing_cc');

create or replace function public._comment_body_blocked(p_body text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select reason_label
    from public.comment_block_patterns
   where enabled is true
     and p_body ~* pattern
   order by reason_label
   limit 1
$$;

revoke all on function public._comment_body_blocked(text)
  from public, anon, authenticated;
-- No external grant: callers are SECURITY DEFINER functions in this
-- schema (create_comment). An external direct call is intentionally
-- not supported — the gate lives at the write boundary.

comment on function public._comment_body_blocked(text) is
  'Scans the enabled public.comment_block_patterns rows and returns '
  'the first matching reason_label (lexicographic order) or NULL. '
  'Called from create_comment. SECURITY DEFINER so the reading role '
  'can traverse comment_block_patterns through RLS; no direct caller '
  'grants on purpose.';

-- -------------------------------------------------------------------
-- create_comment: inject the body-safety check between length and
-- rate-limit. Rest of the function is byte-for-byte from
-- 20261126000000.
-- -------------------------------------------------------------------

create or replace function public.create_comment(
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
  v_block_reason   text;
  v_row            public.comments;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  v_body := btrim(coalesce(p_body, ''));
  if char_length(v_body) < 1 or char_length(v_body) > 500 then
    raise exception 'comments: body length out of range (1..500)'
      using errcode = '22023';
  end if;

  -- Safety pre-check. A non-null label means an enabled pattern in
  -- public.comment_block_patterns matched. 23514 (check_violation)
  -- is reused because the body failed a content check; the tRPC
  -- layer maps this to a generic "This comment violates our rules."
  -- surface without leaking the matched pattern.
  v_block_reason := public._comment_body_blocked(v_body);
  if v_block_reason is not null then
    raise exception 'comments: body_blocked_%', v_block_reason
      using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_user_id::text, 42)
  );

  select count(*) into v_recent_count
    from public.comments
   where user_id = v_user_id
     and created_at > now() - interval '24 hours';
  if v_recent_count >= 60 then
    raise exception 'comments: rate limit exceeded (60 / 24h)'
      using errcode = '54000';
  end if;

  select exists (select 1 from public.news_topics where id = p_topic_id)
    into v_topic_exists;
  if not v_topic_exists then
    raise exception 'topic not found' using errcode = 'P0002';
  end if;

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

revoke all on function public.create_comment(uuid, uuid, text)        from public, anon;
grant execute on function public.create_comment(uuid, uuid, text)     to authenticated, service_role;

commit;
