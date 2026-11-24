-- Migration: moderation queue.
--
-- Operator-only moderation surface. Self-contained — does NOT touch
-- public.create_comment. A BEFORE INSERT trigger on public.comments
-- enforces the ban check, so this migration applies cleanly on top of
-- any future create_comment rewrite (safety pre-check, AI review hook,
-- etc.) without merge-order coupling.
--
-- Shipping:
--   1. public.comment_bans — one row per banned user.
--   2. public.moderation_audit_log — append-only operator action trail.
--   3. public._enforce_comment_ban() + comments_ban_guard trigger —
--      BEFORE INSERT on public.comments; raises 23506 when the actor
--      is banned. SECURITY DEFINER so the trigger can read
--      comment_bans through RLS deny.
--   4. Three SECURITY DEFINER RPCs:
--      admin_dismiss_report, admin_hide_comment, admin_ban_from_commenting.
--      All take the operator's uuid as the first arg (checked against
--      public.users.id). Granted to service_role only — the web
--      /admin/reports page is gated by OPERATOR_USER_IDS env before
--      the server action reaches a service-role supabase client.
--
-- Access posture:
--   - Tables have RLS on + zero policies. service_role bypasses;
--     authenticated / anon have zero table-level grants.
--   - RPCs granted to service_role only.
--
-- Down:
--   drop function admin_ban_from_commenting, drop function
--   admin_hide_comment, drop function admin_dismiss_report, drop
--   trigger comments_ban_guard on public.comments, drop function
--   public._enforce_comment_ban, drop table moderation_audit_log,
--   drop table comment_bans.

begin;

-- --------------------------------------------------------------------
-- 1) comment_bans.
-- --------------------------------------------------------------------

create table public.comment_bans (
  user_id         uuid primary key references public.users(id) on delete cascade,
  banned_at       timestamptz not null default now(),
  -- Nullable so the operator row can be deleted without blocking the
  -- ban record. ON DELETE SET NULL would otherwise contradict NOT NULL.
  banned_by       uuid references public.users(id) on delete set null,
  reason          text not null check (char_length(reason) between 1 and 500)
);

create index comment_bans_banned_at_idx on public.comment_bans (banned_at desc);
create index comment_bans_banned_by_idx on public.comment_bans (banned_by);

alter table public.comment_bans enable row level security;

revoke all on table public.comment_bans from public, anon, authenticated;

comment on table public.comment_bans is
  'Users banned from public.create_comment. Writer: public.admin_ban_from_commenting(). '
  'Reader: service_role only (operator triage) and the BEFORE INSERT trigger on comments.';

-- --------------------------------------------------------------------
-- 2) moderation_audit_log.
-- --------------------------------------------------------------------

create table public.moderation_audit_log (
  id              uuid primary key default gen_random_uuid(),
  -- Nullable so the operator row can be deleted without breaking the
  -- audit trail. Same ON DELETE / NOT NULL contradiction otherwise.
  operator_id     uuid references public.users(id) on delete set null,
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
create index moderation_audit_log_report_idx
  on public.moderation_audit_log (report_id) where report_id is not null;
create index moderation_audit_log_comment_idx
  on public.moderation_audit_log (comment_id) where comment_id is not null;
create index moderation_audit_log_target_user_idx
  on public.moderation_audit_log (target_user_id) where target_user_id is not null;

alter table public.moderation_audit_log enable row level security;

revoke all on table public.moderation_audit_log from public, anon, authenticated;

comment on table public.moderation_audit_log is
  'Append-only audit trail of operator moderation actions. One row per '
  'RPC invocation. service_role bypass gives the operator triage surface '
  'read; authenticated/anon see nothing.';

-- --------------------------------------------------------------------
-- 3) Ban-check trigger on public.comments.
--
-- Decoupled from create_comment on purpose. A direct INSERT by a
-- service-role batch tool would still be caught (good); the trigger
-- fires on every row regardless of session role.
-- --------------------------------------------------------------------

create function public._enforce_comment_ban() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_banned boolean;
begin
  select exists (select 1 from public.comment_bans where user_id = new.user_id)
    into v_banned;
  if v_banned then
    raise exception 'comments: user_banned' using errcode = '23506';
  end if;
  return new;
end;
$$;

revoke all on function public._enforce_comment_ban() from public, anon, authenticated;

create trigger comments_ban_guard
  before insert on public.comments
  for each row execute function public._enforce_comment_ban();

-- --------------------------------------------------------------------
-- 4a) admin_dismiss_report.
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
  v_found       boolean;
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
     and status = 'open'
   returning true into v_found;
  if v_found is null then
    raise exception 'moderation: report_not_open' using errcode = 'P0001';
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
-- 4b) admin_hide_comment. Soft-deletes the comment (clears body, stamps
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
  v_hidden      boolean;
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
   returning true into v_hidden;
  if v_hidden is null then
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
-- 4c) admin_ban_from_commenting.
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

commit;
