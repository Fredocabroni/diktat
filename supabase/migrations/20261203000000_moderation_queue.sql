-- Migration: moderation queue.
--
-- Adds the operator-only moderation surface:
--
--   1. public.comment_bans — one row per banned user. The create_comment
--      RPC consults this and refuses to insert when a row exists.
--   2. public.moderation_audit_log — append-only audit trail for every
--      operator action. Captures the operator uuid, the action verb,
--      the target row(s), and a free-text reason.
--   3. Three SECURITY DEFINER operator RPCs — the only writers that
--      can mutate reports.status, soft-delete a comment, or write a
--      ban row. All three take the operator's uuid as the first arg
--      (checked against users.id existence); none of them derive the
--      actor from auth.uid() because the server-action caller holds a
--      service-role JWT, not the operator's session.
--   4. create_comment is CREATED OR REPLACED to inject a ban check
--      between the safety pre-check (migration 20261202000000) and the
--      rate-limit gate. The body is byte-for-byte from 20261126000000
--      plus the two injections.
--
-- Access posture:
--   - comment_bans + moderation_audit_log have RLS on + zero policies.
--     service_role bypasses RLS; the three RPCs are the only writers.
--     authenticated / anon have no table-level grants.
--   - The RPCs are granted to service_role ONLY. The web /admin/reports
--     page is gated by an OPERATOR_USER_IDS env on the Next.js server
--     before any action runs; passing that check it invokes the RPC
--     with a service-role supabase client.
--
-- Up: see sections below.
-- Down: drop function admin_ban_from_commenting, drop function
--       admin_hide_comment, drop function admin_dismiss_report, drop
--       table moderation_audit_log, drop table comment_bans, restore
--       the 20261202000000 create_comment body.

begin;

-- --------------------------------------------------------------------
-- 1) comment_bans.
-- --------------------------------------------------------------------

create table public.comment_bans (
  user_id         uuid primary key references public.users(id) on delete cascade,
  banned_at       timestamptz not null default now(),
  banned_by       uuid not null references public.users(id) on delete set null,
  reason          text not null check (char_length(reason) between 1 and 500)
);

create index comment_bans_banned_at_idx on public.comment_bans (banned_at desc);

alter table public.comment_bans enable row level security;

revoke all on table public.comment_bans from public, anon, authenticated;

comment on table public.comment_bans is
  'Users banned from public.create_comment. Writer: public.admin_ban_from_commenting(). '
  'Reader: service_role only (operator triage) and create_comment internally.';

-- --------------------------------------------------------------------
-- 2) moderation_audit_log.
-- --------------------------------------------------------------------

create table public.moderation_audit_log (
  id              uuid primary key default gen_random_uuid(),
  operator_id     uuid not null references public.users(id) on delete set null,
  action          text not null check (
    action in ('dismiss_report', 'hide_comment', 'ban_from_commenting')
  ),
  report_id       uuid references public.reports(id) on delete set null,
  comment_id      uuid references public.comments(id) on delete set null,
  target_user_id  uuid references public.users(id) on delete set null,
  reason          text check (reason is null or char_length(reason) between 1 and 500),
  created_at      timestamptz not null default now()
);

create index moderation_audit_log_recent_idx
  on public.moderation_audit_log (created_at desc);
create index moderation_audit_log_operator_idx
  on public.moderation_audit_log (operator_id, created_at desc);

alter table public.moderation_audit_log enable row level security;

revoke all on table public.moderation_audit_log from public, anon, authenticated;

comment on table public.moderation_audit_log is
  'Append-only audit trail of operator moderation actions. One row per '
  'RPC invocation. service_role bypass gives the operator triage surface '
  'read; authenticated/anon see nothing.';

-- --------------------------------------------------------------------
-- 3a) admin_dismiss_report.
-- --------------------------------------------------------------------

create function public.admin_dismiss_report(
  p_operator_id uuid,
  p_report_id   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operator_ok boolean;
  v_prev_status text;
begin
  if p_operator_id is null then
    raise exception 'moderation: operator_required' using errcode = 'P0001';
  end if;
  select exists (select 1 from public.users where id = p_operator_id)
    into v_operator_ok;
  if not v_operator_ok then
    raise exception 'moderation: operator_not_found' using errcode = 'P0001';
  end if;

  update public.reports
     set status = 'dismissed'
   where id = p_report_id
   returning status into v_prev_status;
  if v_prev_status is null then
    raise exception 'moderation: report_not_found' using errcode = 'P0001';
  end if;

  insert into public.moderation_audit_log (operator_id, action, report_id)
    values (p_operator_id, 'dismiss_report', p_report_id);

  return jsonb_build_object('outcome', 'dismissed', 'report_id', p_report_id);
end;
$$;

revoke all on function public.admin_dismiss_report(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_dismiss_report(uuid, uuid) to service_role;

-- --------------------------------------------------------------------
-- 3b) admin_hide_comment. Soft-deletes the comment (clears body, stamps
--      deleted_at) and marks the originating report (if any) actioned.
-- --------------------------------------------------------------------

create function public.admin_hide_comment(
  p_operator_id uuid,
  p_comment_id  uuid,
  p_report_id   uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operator_ok boolean;
  v_comment_ok  boolean;
begin
  if p_operator_id is null then
    raise exception 'moderation: operator_required' using errcode = 'P0001';
  end if;
  select exists (select 1 from public.users where id = p_operator_id)
    into v_operator_ok;
  if not v_operator_ok then
    raise exception 'moderation: operator_not_found' using errcode = 'P0001';
  end if;

  update public.comments
     set body = '',
         deleted_at = now()
   where id = p_comment_id
     and deleted_at is null
   returning true into v_comment_ok;
  if v_comment_ok is null then
    raise exception 'moderation: comment_not_found' using errcode = 'P0001';
  end if;

  if p_report_id is not null then
    update public.reports set status = 'actioned' where id = p_report_id;
  end if;

  insert into public.moderation_audit_log (operator_id, action, comment_id, report_id)
    values (p_operator_id, 'hide_comment', p_comment_id, p_report_id);

  return jsonb_build_object('outcome', 'hidden', 'comment_id', p_comment_id);
end;
$$;

revoke all on function public.admin_hide_comment(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_hide_comment(uuid, uuid, uuid) to service_role;

-- --------------------------------------------------------------------
-- 3c) admin_ban_from_commenting.
-- --------------------------------------------------------------------

create function public.admin_ban_from_commenting(
  p_operator_id uuid,
  p_user_id     uuid,
  p_reason      text,
  p_report_id   uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operator_ok boolean;
  v_target_ok   boolean;
  v_reason      text;
begin
  if p_operator_id is null then
    raise exception 'moderation: operator_required' using errcode = 'P0001';
  end if;
  select exists (select 1 from public.users where id = p_operator_id)
    into v_operator_ok;
  if not v_operator_ok then
    raise exception 'moderation: operator_not_found' using errcode = 'P0001';
  end if;
  select exists (select 1 from public.users where id = p_user_id)
    into v_target_ok;
  if not v_target_ok then
    raise exception 'moderation: target_not_found' using errcode = 'P0001';
  end if;
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null or char_length(v_reason) > 500 then
    raise exception 'moderation: reason length out of range (1..500)'
      using errcode = '22023';
  end if;

  insert into public.comment_bans (user_id, banned_by, reason)
    values (p_user_id, p_operator_id, v_reason)
    on conflict (user_id) do update
      set banned_at = now(),
          banned_by = excluded.banned_by,
          reason = excluded.reason;

  if p_report_id is not null then
    update public.reports set status = 'actioned' where id = p_report_id;
  end if;

  insert into public.moderation_audit_log
    (operator_id, action, target_user_id, report_id, reason)
    values (p_operator_id, 'ban_from_commenting', p_user_id, p_report_id, v_reason);

  return jsonb_build_object('outcome', 'banned', 'user_id', p_user_id);
end;
$$;

revoke all on function public.admin_ban_from_commenting(uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_ban_from_commenting(uuid, uuid, text, uuid)
  to service_role;

-- --------------------------------------------------------------------
-- 4) create_comment: inject the comment_bans gate between the safety
--    pre-check and the rate-limit perform pg_advisory_xact_lock(). Rest
--    is byte-for-byte from 20261202000000.
-- --------------------------------------------------------------------

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
  v_banned         boolean;
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

  v_block_reason := public._comment_body_blocked(v_body);
  if v_block_reason is not null then
    raise exception 'comments: body_blocked_%', v_block_reason
      using errcode = '23514';
  end if;

  -- Operator-issued ban. 23506 (restrict_violation) re-used; the tRPC
  -- layer maps this to a generic "You can't post comments." without
  -- leaking the ban reason.
  select exists (select 1 from public.comment_bans where user_id = v_user_id)
    into v_banned;
  if v_banned then
    raise exception 'comments: user_banned' using errcode = '23506';
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
