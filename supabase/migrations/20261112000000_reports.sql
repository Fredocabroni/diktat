-- Migration: content reporting.
--
-- A users-report-content surface. The reporter inserts rows through
-- a SECURITY DEFINER RPC (which stamps auth.uid() as reporter_user_id);
-- rows are visible only to service_role (no SELECT policy, no end-user
-- read path).
--
-- target_type is a controlled vocabulary — new content surfaces must
-- land here with the same migration that adds the UI call site, so a
-- hostile client cannot invent a value the operator inbox can't
-- triage.
--
-- Invariants enforced by this migration (push 3/3, 2026-10-22):
--
--   1. DB-side throttle: 10 reports per reporter per rolling hour,
--      checked inside the RPC against the reporter's existing rows.
--   2. Target row must exist. target_type → table map (debate_arg →
--      public.debate_arguments; drop → public.news_topics; user →
--      public.users); unknown target_id raises 'target_not_found'.
--   3. One report per (reporter_user_id, target_type, target_id).
--      Partial unique index gates the invariant; the RPC catches the
--      unique_violation and returns {outcome: 'already_reported', id:
--      <existing>} instead of raising, so a user who re-reports the
--      same target sees a quiet acknowledgment, not a loud error.
--   4. Age gate: the reporter must have passed the 18+ attestation
--      (public.users.age_verified_at is non-null). Same column the
--      /onboard/age gate uses.
--   5. updated_at trigger via public.set_updated_at() so the operator
--      triage surface tracks last change.
--
-- Up:
--   create table public.reports …
--   enable RLS; no policies (service_role bypasses).
--   create unique partial index on (reporter_user_id, target_type, target_id).
--   create updated_at trigger via set_updated_at().
--   create function public.submit_report(text, uuid, text) returns jsonb …
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
    target_type in ('debate_arg', 'drop', 'user')
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

-- Unique: one report per (reporter, target_type, target_id).
-- Partial so anonymized rows (reporter_user_id IS NULL after account
-- deletion) don't conflict with each other or with live rows.
create unique index reports_reporter_target_uniq
  on public.reports (reporter_user_id, target_type, target_id)
  where reporter_user_id is not null;

-- updated_at trigger reusing the repo-wide helper (migration 0001).
create trigger reports_set_updated_at
  before update on public.reports
  for each row execute function public.set_updated_at();

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
--
-- Returns jsonb { outcome: 'submitted' | 'already_reported', id: uuid }.
-- 'already_reported' is a quiet success — the client shows an
-- acknowledgment, not an error — so a user who re-reports a target
-- doesn't see a loud failure.
--
-- Error vocabulary (sqlstate + prefix on P0001):
--   28000                        → not authenticated
--   22023 (invalid_parameter)    → bad reason or unknown target_type
--   P0001 'reports: age_not_verified'
--                                → reporter has not passed the 18+ gate
--   P0001 'reports: target_not_found'
--                                → target_id missing from its mapped table
--   P0001 'reports: rate_limited'
--                                → >=10 reports from this user in the last hour
-- --------------------------------------------------------------------

create function public.submit_report(
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

  -- Reason: trim + length-cap. The CHECK downstream re-asserts, but
  -- the explicit raise gives the resolver a stable 22023 signal
  -- rather than a generic check-constraint violation.
  p_reason := nullif(btrim(p_reason), '');
  if p_reason is null or char_length(p_reason) > 2000 then
    raise exception 'reports: reason length out of range (1..2000)'
      using errcode = '22023';
  end if;

  if p_target_type not in ('debate_arg', 'drop', 'user') then
    raise exception 'reports: unknown target_type %', p_target_type
      using errcode = '22023';
  end if;

  -- Age gate. The RPC runs with SECURITY DEFINER, so it can read
  -- public.users directly. age_verified_at is the single source of
  -- truth for the 18+ gate (migration 20261108000000).
  select age_verified_at into v_age_verified
    from public.users where id = v_user_id;
  if v_age_verified is null then
    raise exception 'reports: age_not_verified'
      using errcode = 'P0001';
  end if;

  -- Target existence check. Each target_type maps to one table; the
  -- EXISTS lookup is pk-indexed so this costs ~one index probe.
  if p_target_type = 'debate_arg' then
    select exists (select 1 from public.debate_arguments where id = p_target_id)
      into v_target_ok;
  elsif p_target_type = 'drop' then
    select exists (select 1 from public.news_topics where id = p_target_id)
      into v_target_ok;
  elsif p_target_type = 'user' then
    select exists (select 1 from public.users where id = p_target_id)
      into v_target_ok;
  else
    v_target_ok := false;
  end if;
  if not v_target_ok then
    raise exception 'reports: target_not_found'
      using errcode = 'P0001';
  end if;

  -- 10-per-rolling-hour throttle. Counts the reporter's own rows
  -- (reporter_user_id = auth.uid()) in the last hour; anonymized rows
  -- (reporter_user_id IS NULL) don't contribute since they're no
  -- longer attributable.
  select count(*) into v_recent_count
    from public.reports
    where reporter_user_id = v_user_id
      and created_at > now() - interval '1 hour';
  if v_recent_count >= 10 then
    raise exception 'reports: rate_limited'
      using errcode = 'P0001';
  end if;

  -- Try the insert. ON CONFLICT short-circuits the second attempt by
  -- the same reporter against the same target: the partial unique
  -- index gates (reporter_user_id, target_type, target_id) when
  -- reporter_user_id IS NOT NULL. We DO NOTHING and fall through to a
  -- SELECT so the caller receives the existing report id — a quiet
  -- "already reported" acknowledgment.
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
      and target_type = p_target_type
      and target_id = p_target_id;
  return jsonb_build_object('outcome', 'already_reported', 'id', v_existing_id);
end;
$$;

revoke all on function public.submit_report(text, uuid, text) from public, anon;
grant execute on function public.submit_report(text, uuid, text)
  to authenticated, service_role;

comment on function public.submit_report(text, uuid, text) is
  'User-facing content report writer. Reporter identity derived from '
  'auth.uid(); reason trimmed + length-capped. Enforces age-gate '
  '(users.age_verified_at), target existence (per target_type table), '
  '10/hour throttle, and a one-report-per-target-per-reporter unique '
  'invariant. Returns jsonb { outcome, id }. See migration header for '
  'the sqlstate vocabulary.';

commit;
