-- Migration: operator pick from the digest drives the next Drop.
--
-- Three changes so Michael's digest pick can decide tonight's 8 PM
-- ET Drop (behind HEAT_ENABLED):
--   1. Reschedule the shadow-digest generator + Telegram send to
--      fire BEFORE the next Drop (>=2h prior in both DST modes),
--      not after it. Previous: 01:10 / 01:15 UTC (post-Drop).
--      New: 21:00 / 21:05 UTC = 5 PM EDT / 4 PM EST — comfortably
--      >=3h before the 20:00 ET Drop in both EDT and EST.
--   2. Add `drop_shadow_log.operator_skipped` so the Telegram
--      Skip button can record "no Drop today" (today it is a
--      no-op in digest-poll). Separate boolean, default false, so
--      legacy rows remain "unpicked" not "skipped".
--   3. Add `drop_shadow_log.pick_source` so each Drop records
--      which branch of drop_publish picked it (operator | skip |
--      heat | walker). Next digest reads this to show
--      "Last Drop came from: <source>".
--
-- Plus two SECURITY DEFINER RPCs:
--   - record_drop_shadow_operator_skip(p_drop_date)
--       Upserts a shadow row for the day and marks it skipped.
--   - record_drop_pick_source(p_drop_date, p_pick_source)
--       Upserts the pick_source onto today's shadow row (and
--       inserts a bare row if the generator did not run — the
--       walker path can still land a pick_source).
--
-- Prod max applied at author time: 20261129000000 (comments_select
-- _grants). This file sorts strictly after at 20261130000000.
--
-- Up:
--   select cron.schedule('drop_shadow_digest', '0 21 * * *', ...);
--   select cron.schedule('telegram_digest_send', '5 21 * * *', ...);
--   alter table drop_shadow_log add column operator_skipped,
--                                add column pick_source;
--   create function record_drop_shadow_operator_skip(...);
--   create function record_drop_pick_source(...);
--
-- Down (strict reversal):
--   drop function record_drop_pick_source(date, text);
--   drop function record_drop_shadow_operator_skip(date);
--   alter table drop_shadow_log drop column pick_source;
--   alter table drop_shadow_log drop column operator_skipped;
--   select cron.schedule('drop_shadow_digest', '10 1 * * *', ...);
--   select cron.schedule('telegram_digest_send', '15 1 * * *', ...);

begin;

-- 1. Reschedule crons. cron.schedule(name,...) is upsert-by-name;
--    both entries already exist (created by 20261103 / 20261104),
--    we only update the schedule in place. Idempotency key stays
--    UTC-day based.
select cron.schedule(
  'drop_shadow_digest',
  '0 21 * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key, payload)
    values (
      'drop_shadow_digest',
      to_char(now(), 'YYYY-MM-DD'),
      jsonb_build_object('emitted_at', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
    )
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

select cron.schedule(
  'telegram_digest_send',
  '5 21 * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key, payload)
    values (
      'telegram_digest_send',
      to_char(now(), 'YYYY-MM-DD'),
      jsonb_build_object('emitted_at', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
    )
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

-- 2. Schema.
alter table public.drop_shadow_log
  add column if not exists operator_skipped boolean not null default false;

alter table public.drop_shadow_log
  add column if not exists pick_source text;

alter table public.drop_shadow_log
  drop constraint if exists drop_shadow_log_pick_source_values;
alter table public.drop_shadow_log
  add constraint drop_shadow_log_pick_source_values
    check (pick_source is null or pick_source in ('operator','skip','heat','walker'));

comment on column public.drop_shadow_log.operator_skipped is
  'True when the operator explicitly clicked Skip in the Telegram digest. Distinct from NULL operator_picked_at ("not reviewed yet").';
comment on column public.drop_shadow_log.pick_source is
  'Which branch of drop_publish picked tonight''s Drop: operator | skip | heat | walker. Stamped by the handler after decision.';

-- 3. record_drop_shadow_operator_skip — Telegram Skip button writes
--    through this. Upserts the row (generator writes the full shape
--    at 21:00 UTC; Skip may click before or after — both must work).
create or replace function public.record_drop_shadow_operator_skip(
  p_drop_date date
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  today_et date := (now() at time zone 'America/New_York')::date;
begin
  -- Bound the valid window to ±1 ET-day. Telegram callback_data is
  -- not server-signed, so a replayed or crafted payload could supply
  -- an arbitrary date; this guard prevents pre-seeding
  -- operator_skipped=true for a future date the operator never
  -- intended to skip. ±1 tolerates UTC/ET midnight skew.
  -- (PR #328 security-reviewer LOW-1.)
  if p_drop_date < today_et - 1 or p_drop_date > today_et + 1 then
    raise exception 'record_drop_shadow_operator_skip: drop_date % out of valid window [%, %]',
      p_drop_date, today_et - 1, today_et + 1
      using errcode = 'check_violation';
  end if;

  insert into public.drop_shadow_log as d (
    drop_date,
    operator_skipped,
    operator_picked_at,
    operator_pick_candidate_id
  ) values (
    p_drop_date,
    true,
    now(),
    null
  )
  on conflict (drop_date) do update set
    operator_skipped = true,
    operator_picked_at = now(),
    operator_pick_candidate_id = null,
    operator_notes = 'telegram: skip',
    updated_at = now();
end;
$$;

revoke all on function public.record_drop_shadow_operator_skip(date) from public;
grant execute on function public.record_drop_shadow_operator_skip(date) to service_role;

comment on function public.record_drop_shadow_operator_skip(date) is
  'Admin-write path for the Telegram Skip button. Upserts drop_shadow_log with operator_skipped=true; drop_publish reads this to no-Drop the day when HEAT_ENABLED=true.';

-- 4. record_drop_pick_source — stamped by drop_publish after each
--    decision so the NEXT digest can show "Last Drop came from: X".
--    Upserts; inserts a bare row when no shadow row exists yet
--    (HEAT_SHADOW_ENABLED=false path still records history).
create or replace function public.record_drop_pick_source(
  p_drop_date date,
  p_pick_source text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_pick_source not in ('operator','skip','heat','walker') then
    raise exception 'record_drop_pick_source: invalid pick_source %', p_pick_source
      using errcode = 'check_violation';
  end if;
  insert into public.drop_shadow_log as d (
    drop_date,
    pick_source
  ) values (
    p_drop_date,
    p_pick_source
  )
  on conflict (drop_date) do update set
    pick_source = excluded.pick_source,
    updated_at = now();
end;
$$;

revoke all on function public.record_drop_pick_source(date, text) from public;
grant execute on function public.record_drop_pick_source(date, text) to service_role;

comment on function public.record_drop_pick_source(date, text) is
  'Stamped by drop_publish after each Drop (or skip) with the branch that decided it: operator|skip|heat|walker. Next digest reads this for the "Last Drop came from: X" line.';

commit;
