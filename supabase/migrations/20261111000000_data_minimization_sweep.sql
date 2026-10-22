-- Migration: data minimization scheduler job.
--
-- Pre-launch compliance. Two retention policies this migration enforces:
--
--   1. Age-blocked accounts (<18 self-attested) get purged 7 days after
--      the block was stamped. The /not-eligible page is the user-facing
--      terminal state; after a cool-off, the row goes away.
--
--   2. Pre-launch human accounts that never attested their age get purged
--      30 days after the launch date (2026-10-21). This closes the
--      "orphan unverified account" population that would otherwise sit
--      indefinitely in public.users with age_verified_at IS NULL.
--
-- Bots (`is_bot = true`) are EXCLUDED from both policies. Synthetic
-- accounts are backfilled verified in migration 20261108000000 and have
-- no human subject to the age gate.
--
-- Shipping posture: DRY RUN ON. The RPC takes a `p_dry_run boolean`
-- parameter; the pg_cron entry below passes `true`. The scheduler row
-- carries `{dry_run: true}` in its payload. The worker handler reads
-- the flag and forwards it to the RPC. Flipping to live is a payload
-- edit on the pg_cron entry OR a scheduled_jobs row inserted manually
-- by the operator with `{dry_run: false}`.
--
-- Deletion path: when the RPC runs with `p_dry_run=false`, it DELETEs
-- from auth.users for the matching accounts. CASCADE from
-- public.users.id → auth.users.id does the rest (PR 288 ledger-preserve
-- migration anonymizes ap_transactions.user_id → NULL for us).
--
-- Up:
--   create function public.data_minimization_sweep(boolean) returns jsonb ...
--   revoke all; grant execute to service_role.
--   create pg_cron entry 'data_minimization_sweep_daily' at 03:00 UTC.
--
-- Down:
--   select cron.unschedule('data_minimization_sweep_daily');
--   drop function public.data_minimization_sweep(boolean);

begin;

-- The launch date is baked in as a constant inside the function body —
-- the "30 days after launch" window is a one-shot pre-launch cleanup,
-- not a rolling retention. Future retention policies get their own
-- function + migration.
create function public.data_minimization_sweep(p_dry_run boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_launch_date       date := date '2026-10-21';
  v_pre_launch_window interval := interval '30 days';
  v_block_window      interval := interval '7 days';
  v_blocked_count     int;
  v_pre_launch_count  int;
  v_deleted_blocked   int := 0;
  v_deleted_pre_launch int := 0;
begin
  -- Count candidates for both policies up front — these numbers go
  -- into the log line regardless of dry-run.
  select count(*)
    into v_blocked_count
    from public.users
    where is_bot = false
      and age_blocked_at is not null
      and age_blocked_at < now() - v_block_window;

  select count(*)
    into v_pre_launch_count
    from public.users
    where is_bot = false
      and age_verified_at is null
      and age_blocked_at is null
      and created_at < v_launch_date
      and current_date > v_launch_date + v_pre_launch_window;

  if not p_dry_run then
    -- (1) Age-blocked purge. CASCADE through public.users →
    -- auth.users cleans up every private 1:1 table and anonymizes
    -- ap_transactions (migration 20261110000000).
    with victims as (
      select u.id
        from public.users u
        where u.is_bot = false
          and u.age_blocked_at is not null
          and u.age_blocked_at < now() - v_block_window
    )
    delete from auth.users where id in (select id from victims);
    get diagnostics v_deleted_blocked = row_count;

    -- (2) Pre-launch orphan purge.
    with victims as (
      select u.id
        from public.users u
        where u.is_bot = false
          and u.age_verified_at is null
          and u.age_blocked_at is null
          and u.created_at < v_launch_date
          and current_date > v_launch_date + v_pre_launch_window
    )
    delete from auth.users where id in (select id from victims);
    get diagnostics v_deleted_pre_launch = row_count;
  end if;

  return jsonb_build_object(
    'dry_run',               p_dry_run,
    'blocked_candidates',    v_blocked_count,
    'pre_launch_candidates', v_pre_launch_count,
    'deleted_blocked',       v_deleted_blocked,
    'deleted_pre_launch',    v_deleted_pre_launch,
    'launch_date',           to_char(v_launch_date, 'YYYY-MM-DD'),
    'swept_at',              to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
end;
$$;

-- SECURITY: service_role only. Authenticated users must not be able to
-- enumerate purge candidates (the counts themselves are mildly
-- sensitive — tell you how many <18 attestations happened in the last
-- 7 days). The pg_cron job below runs as the cron role, which has
-- its own privileges managed by the extension.
revoke all on function public.data_minimization_sweep(boolean) from public, anon, authenticated;
grant execute on function public.data_minimization_sweep(boolean) to service_role;

comment on function public.data_minimization_sweep(boolean) is
  'Pre-launch data minimization. Deletes age-blocked accounts >7 days '
  'old and pre-launch orphan accounts (created before 2026-10-21, '
  'never attested) >30 days after launch. Bots excluded. Dry-run by '
  'default: p_dry_run=true returns counts only, p_dry_run=false '
  'performs the DELETE (CASCADEs through public.users; ap_transactions '
  'anonymizes via migration 20261110000000). service_role only.';

-- pg_cron daily entry. Fires 03:00 UTC every day; INSERTs a
-- scheduled_jobs row that the workers consumer claims. Payload sets
-- dry_run=true; operator flips the flag by editing this cron entry
-- OR by inserting a one-shot scheduled_jobs row manually.
select cron.schedule(
  'data_minimization_sweep_daily',
  '0 3 * * *',
  $cron$
    insert into public.scheduled_jobs (job_type, idempotency_key, payload)
    values (
      'data_minimization_sweep',
      to_char(now(), 'YYYY-MM-DD'),
      jsonb_build_object('dry_run', true)
    )
    on conflict (job_type, idempotency_key) where target_user_id is null
    do nothing;
  $cron$
);

commit;
