-- Migration: content reporting.
--
-- A users-report-content surface. The reporter inserts rows through
-- a SECURITY DEFINER RPC (which stamps auth.uid() as reporter_user_id);
-- rows are visible only to service_role (no SELECT policy, no end-user
-- read path). Rate-limited at the tRPC layer via mutationLimit; this
-- migration adds the DB-side invariants.
--
-- target_type is a controlled vocabulary — new content surfaces must
-- land here with the same migration that adds the UI call site, so a
-- hostile client cannot invent a value the operator inbox can't
-- triage.
--
-- Up:
--   create table public.reports …
--   enable RLS; no policies (service_role bypasses).
--   create function public.submit_report(text, uuid, text) returns uuid …
--   grant execute on function to authenticated, service_role.
--
-- Down:
--   drop function public.submit_report(text, uuid, text);
--   drop table public.reports;

begin;

-- --------------------------------------------------------------------
-- 1) Table.
-- --------------------------------------------------------------------

create table public.reports (
  id                 uuid primary key default gen_random_uuid(),
  -- Reporter FK is SET NULL on delete so a report survives the
  -- reporter's self-serve deletion (compliance alignment: the content
  -- is still potentially abusive even after the reporter leaves). The
  -- NULL is itself anonymization — same pattern as ap_transactions.
  reporter_user_id   uuid references public.users(id) on delete set null,
  target_type        text not null check (
    target_type in ('debate_arg', 'debate_post', 'drop', 'user')
  ),
  target_id          uuid not null,
  reason             text not null check (
    char_length(reason) between 1 and 2000
  ),
  status             text not null default 'open' check (
    status in ('open', 'reviewed', 'actioned', 'dismissed')
  ),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index reports_reporter_recent_idx on public.reports
  (reporter_user_id, created_at desc);
create index reports_target_idx on public.reports
  (target_type, target_id);
create index reports_open_idx on public.reports
  (created_at desc) where status = 'open';

-- RLS: enable, no policies. service_role bypasses RLS by default so
-- the operator's admin surfaces can read; authenticated/anon see
-- nothing on direct PostgREST SELECT.
alter table public.reports enable row level security;

-- No GRANTs on the table surface — service_role reads via its implicit
-- bypass; authenticated / anon have zero read/write via PostgREST.
revoke all on public.reports from public, anon, authenticated;

comment on table public.reports is
  'User-submitted content reports. Writer: public.submit_report() RPC '
  '(reporter stamped from auth.uid()). Reader: service_role only '
  '(operator triage surfaces).';

-- --------------------------------------------------------------------
-- 2) submit_report RPC — the only writer.
-- --------------------------------------------------------------------

create function public.submit_report(
  p_target_type text,
  p_target_id   uuid,
  p_reason      text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_id      uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- Trim + length-cap at the function boundary so an undersized or
  -- oversized reason reaches the CHECK constraint only on genuinely
  -- bad input (not whitespace variance).
  p_reason := nullif(btrim(p_reason), '');
  if p_reason is null or char_length(p_reason) > 2000 then
    raise exception 'reports: reason length out of range (1..2000)'
      using errcode = '22023';
  end if;

  -- target_type is validated by the CHECK; a direct raise here gives
  -- the resolver a cleaner BAD_REQUEST signal with a stable sqlstate.
  if p_target_type not in ('debate_arg', 'debate_post', 'drop', 'user') then
    raise exception 'reports: unknown target_type %', p_target_type
      using errcode = '22023';
  end if;

  insert into public.reports (reporter_user_id, target_type, target_id, reason)
  values (v_user_id, p_target_type, p_target_id, p_reason)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.submit_report(text, uuid, text) from public, anon;
grant execute on function public.submit_report(text, uuid, text)
  to authenticated, service_role;

comment on function public.submit_report(text, uuid, text) is
  'User-facing content report writer. Reporter identity derived from '
  'auth.uid(); reason trimmed + length-capped. Raises 28000 on anon, '
  '22023 on bad reason or target_type. Rate-limited at the tRPC '
  'mutationLimit layer (reports.submit).';

commit;
